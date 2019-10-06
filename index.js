const _debug = require('debug')
const assert = require('assert')
const { Duplex } = require('stream')
const { nextTick } = process
const { SubstreamOp } = require('./messages')

const INIT = 'INIT'
const ESTABLISHED = 'ESTABLISHED'
const CLOSING = 'CLOSING'
const END = 'END'

const OP_START_STREAM = 1
const OP_DATA = 2
const OP_CLOSE_STREAM = 3

const RETRY_INTERVAL = 300

class SubstreamRouter {
  get name () { return 'substream' }
  constructor (opts = {}) {
    this.encoding = SubstreamOp
    this.id = randbytes(2).hexSlice()
    this.subs = []
    this._ridTable = {}
    this._nameTable = {}
    this.handlers = opts

    // TODO: stream is not guaranteed in extension space
    this._onUnpipe = this._onUnpipe.bind(this)
    // this.stream.once('unpipe', this._onUnpipe)
  }

  addSub (sub) {
    sub.id = this.subs.push(sub) - 1
    this._nameTable[sub.name] = sub
  }

  delSub (sub) {
    if (sub.state === INIT || sub.state === ESTABLISHED) {
      console.warn('Warn: mainstream closed while substream was initializing or active')
      sub._transition(CLOSING)
    }
    if (typeof sub.rid !== 'undefined') {
      delete this._ridTable[sub.rid]
    }
    delete this._nameTable[sub.name]
    this.subs[sub.id] = null
  }

  // Forward unpipe events to active substreams
  _onUnpipe (src) {
    this.subs.forEach(s => {
      if (s) s.emit('unpipe', src)
    })
  }

  _onDestroyed () {
    delete this.stream.__subrouter
    delete this.stream

    this.subs.forEach(i => {
      if (i) this.delSub(i)
    })
  }

  onmessage (msg, peer) {
    const remoteId = decId(msg.id)

    if (msg.op === OP_START_STREAM) {
      // console.log('Received hanshake ns:', msg.data.hexSlice)
      const sub = this._nameTable[msg.data.toString('utf8')]
      if (!sub) {
        if (typeof this.handlers.onsubdiscovery === 'function') this.handlers.onsubdiscovery(msg.data.toString('utf8'), peer)
        return
      }

      // Link remote sub to local sub
      if (sub.state === INIT) {
        sub.rid = remoteId
        this._ridTable[remoteId] = sub
        sub._peer = peer // bind sub to peer
        sub._transition(ESTABLISHED)
      } // else ignore message
    } else {
      const sub = this._ridTable[remoteId]
      if (!sub) return
      sub._onMessage(msg)
    }
  }

  emitStream (ev, ...payload) {
    // this.stream.emit(ev, ...payload)
  }

  open (name, opts = {}, cb) {
    if (typeof opts === 'function') return this.open(name, undefined, opts)
    if (typeof name === 'string') name = Buffer.from(name)

    assert(Buffer.isBuffer(name), '"namespace" must be a String or a Buffer')

    // Detect duplicate namespaces
    if (this._nameTable[name.toString('utf8')]) {
      const err = new NamespaceConflictError(name)
      if (typeof cb === 'function') return cb(err)
      else throw err
    }

    const sub = new SubStream(this, name, opts)

    if (typeof cb === 'function') {
      let invkd = false
      sub.once('connected', () => {
        if (invkd) return
        cb(null, sub)
        invkd = true
      })
      sub.once('error', err => {
        if (invkd) return
        cb(err)
        invkd = true
      })
    }

    const handshakeTimeout = opts.timeout || 5000 // default 5 sec
    let timeWaited = 0
    const broadcast = () => {
      setTimeout(() => {
        if (sub.state !== INIT) return
        timeWaited += RETRY_INTERVAL
        if (timeWaited > handshakeTimeout) return sub._transition(CLOSING, new Error('HandshakeTimeoutError'))
        sub._sendHandshake()
        broadcast()
      }, RETRY_INTERVAL)
    }
    broadcast()

    return sub
  }
}

const randbytes = (n) => Buffer.from(Array.from(new Array(n)).map(i => Math.floor(0xff * Math.random())))
class SubStream extends Duplex {
  constructor (router, name, opts = {}) {
    super(Object.assign({}, opts, { allowHalfOpen: false }))
    this.pause()
    this.cork()

    this.name = name || randbytes(32)
    this.state = INIT
    this.lastError = null

    this.router = router
    this.router.addSub(this)

    this.debug = _debug(`substream/R ${this.router.id} S ${this.id}`)
    this.debug('Initializing new substream')
  }

  _write (chunk, enc, done) {
    // this.debug('DATA sub => remote', chunk.toString())
    const msg = {
      id: encId(this.id),
      op: OP_DATA,
      data: chunk
    }
    this.router.send(msg, this._peer)
    nextTick(done)
  }

  _final (cb) {
    if (this.state !== END) this._transition(CLOSING, null, cb)
  }

  _read (size) {
    // I don't know if it matters that we completely ignore
    // the client reads and sizes.
    // this.debug('sub read req', size)
  }

  _sendHandshake () {
    this.debug('Sending handshake, ns:', this.name.toString())
    this.router.broadcast({
      id: encId(this.id),
      op: OP_START_STREAM,
      data: this.name
    })
  }

  _sendClosing () {
    this.debug('Sending close stream op')
    this.router.send({
      id: encId(this.id),
      op: OP_CLOSE_STREAM,
      data: this.name
    }, this._peer)
  }

  _transition (nstate, err, finalize) {
    const prev = this.state
    this.debug('STATE CHANGED', prev, '=>', nstate)
    switch (prev) {
      case INIT:
        switch (nstate) {
          case ESTABLISHED:
            // send 1 last handshake incase previous weren't received
            this._sendHandshake()
            this.uncork()
            this.resume()
            this.state = nstate
            this.emit('connected')
            if (typeof this.router.handlers.onsubconnect === 'function') {
              this.router.handlers.onsubconnect(this)
            }
            break
          case CLOSING:
            this.state = nstate
            return this._transition(END, err, finalize)
          default:
            throw new Error('IllegalTransitionError' + nstate)
        }
        break

      case ESTABLISHED:
        switch (nstate) {
          case CLOSING:
            this.state = nstate
            this._sendClosing()
            this.push(null) // end readstream
            return nextTick(() => this._transition(END, err, finalize))
          default:
            throw new Error('IllegalTransitionError' + nstate)
        }

      case CLOSING:
        switch (nstate) {
          case END:
            // TODO: proper end/destroy handling?
            if (err && !this.destroyed) this.destroy(err)
            else if (!this.destroyed) {
              this.push(null) // end readable
              this.end() // end writable
            }
            this.state = nstate
            this.router.delSub(this)
            if (typeof finalize === 'function') finalize()
            if (typeof this.router.handlers.onsubclose === 'function') {
              this.router.handlers.onsubclose(this)
            }
            break
          default:
            throw new Error('IllegalTransitionError' + nstate)
        }
        break
      default:
        throw new Error('IllegalTransitionError' + nstate)
    }
  }

  _onMessage (msg) {
    switch (this.state) {
      case ESTABLISHED:
        switch (msg.op) {
          case OP_DATA:
            // this.debug('DATA remote => sub', msg.data.toString())
            this.push(msg.data)
            break
          case OP_CLOSE_STREAM:
            this.debug('Received close from remote')
            this.end()
            break
        }
        break

      case CLOSING:
        // If we're already closing we can ignore the
        // closing echos from the other end.
        if (msg.op === OP_CLOSE_STREAM) break
        // else fall through to invalid state error
      case INIT:
      case END:
        throw new Error('Impossible state, BUG!')
    }
  }
}

module.exports = SubstreamRouter

function encId (id) {
  return Buffer.from([(id >> 8) & 0xff, id & 0xff])
}

function decId (id) {
  return id[0] << 8 | id[1]
}

class NamespaceConflictError extends Error {
  constructor (name, ...params) {
    const msg = 'A substream with the same already exists on this feed'
    super(msg, ...params)
    this.conflict = name
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) Error.captureStackTrace(this, NamespaceConflictError)
    this.name = this.type = 'NamespaceConflictError'
  }
}
