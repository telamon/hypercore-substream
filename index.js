const _debug = require('debug')
const assert = require('assert')
const eos = require('end-of-stream')
const { Duplex } = require('stream')
const { nextTick } = process
const { SubstreamOp } = require('./messages')

const EXTENSION = 'substream'
const INIT = 'INIT'
const ESTABLISHED = 'ESTABLISHED'
const CLOSING = 'CLOSING'
const END = 'END'

const OP_START_STREAM = 1
const OP_DATA = 2
const OP_CLOSE_STREAM = 3

const RETRY_INTERVAL = 500

class SubstreamRouter {
  constructor (feed) {
    this.subs = []
    this._ridTable = {}
    this._nameTable = {}

    this.feed = feed
    this._onExtension = this._onExtension.bind(this)
    this._onDestroyed = this._onDestroyed.bind(this)
    this.feed.once('close', this._onDestroyed)
    this.feed.on('extension', this._onExtension)
  }

  addSub (sub) {
    sub.id = this.subs.push(sub) - 1
    this._nameTable[sub.name] = sub
  }

  delSub (sub) {
    if (typeof sub.rid !== 'undefined') {
      delete this._ridTable[sub.rid]
    }
    delete this._nameTable[sub.name]
    this.subs[sub.id] = null
  }

  _onDestroyed () {
    this.feed.off('extension', this._onExtension)
    delete this.feed.__subrouter

    this.subs.forEach(i => {
      if (i) this.delSub(i)
    })
    delete this.feed
    delete this.subs
    delete this
  }

  _onExtension (ext, chunk) {
    if (ext !== EXTENSION) return
    const msg = SubstreamOp.decode(chunk)
    const remoteId = decId(msg.id)
    if (msg.op === OP_START_STREAM) {
      const sub = this._nameTable[msg.data.toString('utf8')]
      if (!sub) return this.emitStream('substream-discovered', msg.data.toString('utf8'))

      // Link remote sub to local sub
      if (sub.state === INIT) {
        sub.rid = remoteId
        this._ridTable[remoteId] = sub
        sub._transition(ESTABLISHED)
      } // else ignore message
    } else {
      const sub = this._ridTable[remoteId]
      if (!sub) return
      sub._onMessage(msg)
    }
  }

  transmit (buffer) {
    this.feed.extension(EXTENSION, buffer)
  }

  emitStream (ev, ...payload) {
    this.feed.stream.emit(ev, ...payload)
  }
}

const randbytes = () => Buffer.from(Math.floor((1 << 24) * Math.random()).toString(16), 'hex')
class SubStream extends Duplex {
  constructor (feed, name, opts = {}) {
    super(Object.assign({}, opts, { allowHalfOpen: false }))
    this.pause()
    this.cork()

    if (typeof name === 'string') name = Buffer.from(name)
    this.name = name || randbytes()
    this.state = INIT
    this.lastError = null

    // Install router into feed if missing.
    if (!feed.__subrouter) {
      feed.__subrouter = new SubstreamRouter(feed)
    }
    this.router = feed.__subrouter
    this.router.addSub(this)
    this.debug = _debug(`substream/${this.id}`)
    this.debug('Initializing new substream')
  }

  _write (chunk, enc, done) {
    // this.debug('DATA sub => remote', chunk.toString())
    const bin = SubstreamOp.encode({
      id: encId(this.id),
      op: OP_DATA,
      data: chunk
    })
    this.router.transmit(bin)
    nextTick(done)
  }

  _final (cb) {
    if (this.state !== END) this._transition(CLOSING, null, cb)
  }

  _read (size) {
    this.debug('sub read req')
  }

  _sendHandshake () {
    this.debug('Sending handshake')

    this.router.transmit(SubstreamOp.encode({
      id: encId(this.id),
      op: OP_START_STREAM,
      data: this.name
    }))
  }

  _sendClosing () {
    this.debug('Sending close stream op')
    this.router.transmit(SubstreamOp.encode({
      id: encId(this.id),
      op: OP_CLOSE_STREAM,
      data: this.name
    }))
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
            this.router.emitStream('substream-connected', this)
            this.debug('Received hanshake from remote, INITIALIZED!')
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
            this.router.emitStream('substream-disconnected', this)
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
      case INIT:
        throw new Error('Impossible state, BUG!')
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
      case END:
        throw new Error('Impossible state, BUG!')
    }
  }
}

const substream = (feed, key, opts = {}, cb) => {
  if (typeof key === 'function') return substream(feed, undefined, undefined, key)
  if (typeof opts === 'function') return substream(feed, key, undefined, opts)
  assert(typeof feed.extension === 'function')
  assert(feed.stream)
  const sub = new SubStream(feed, key, opts, cb)

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

module.exports = substream
module.exports.EXTENSION = 'substream'

function encId (id) {
  return Buffer.from([(id >> 8) & 0xff, id & 0xff])
}

function decId (id) {
  return id[0] << 8 | id[1]
}
