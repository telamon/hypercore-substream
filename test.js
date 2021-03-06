const test = require('tape')
const Protocol = require('hypercore-protocol')
const Substream = require('.')
const pump = require('pump')
const eos = require('end-of-stream')
const hypercore = require('hypercore')
const ram = require('random-access-memory')
const { PeerConnection } = require('decentstack')

test('virtual channels on decentstack PeerConnection', t => {
  t.plan(21)
  const key = Buffer.alloc(32)
  key.write('encryption secret')

  const peer1 = new PeerConnection(true, key, {
    onclose: t.error
  })
  const p1subs = peer1.registerExtension(new Substream())

  const peer2 = new PeerConnection(false, key, {
    onclose: t.error
  })

  const p2subs = peer2.registerExtension(new Substream())

  // Initialize virtual substreams
  const subA1 = p1subs.open('beef', (err, sub) => {
    t.error(err)
    t.ok(sub, 'Callback invoked')
  })

  const subA2 = p2subs.open(Buffer.from('beef'))

  const msg1 = Buffer.from('Hello from localhost')
  const msg2 = Buffer.from('Hello from remotehost')
  const msg3 = Buffer.from('SubA1 end')
  const msg4 = Buffer.from('SubA2 end')

  let pending = 4
  const finish = () => {
    if (--pending) return
    t.ok(true, 'Both subchannels closed')
    // Original streams are alive
    t.equal(peer1.stream.destroyed, false)
    // t.equal(stream1.writable, true) // TODO: streamx dosen't support it yet
    t.equal(peer1.stream.readable, true)
    t.equal(peer2.stream.destroyed, false)
    // t.equal(stream2.writable, true) // TODO: streamx. dosen't support it yet
    t.equal(peer2.stream.readable, true)

    // But substreams have ended
    t.equal(subA1.readable, false)
    t.equal(subA1.writable, false)
    t.equal(subA2.readable, false)
    t.equal(subA2.writable, false)
    t.end()
  }

  eos(subA1, err => { t.error(err, 'Subchannel subA1 ended peacefully'); finish() })
  eos(subA2, err => { t.error(err, 'Subchannel subA2 ended peacefully'); finish() })
  pump(peer1.stream, peer2.stream, peer1.stream, err => {
    t.error(err, 'replication stream ended')
    t.ok(true, 'Async flow complete')
    t.end()
  })

  subA1.once('data', chunk => {
    t.equal(chunk.toString('utf8'), msg2.toString('utf8'), 'Message 1 transmitted')

    subA1.once('data', chunk => {
      t.equal(chunk.toString('utf8'), msg4.toString('utf8'), 'Message 4 transmitted')
    })
    subA1.end(msg3, err => {
      t.error(err)
      t.ok(true, 'SubA1 closed via end()')
      finish()
    })
  })
  subA2.once('data', chunk => {
    t.equal(chunk.toString('utf8'), msg1.toString('utf8'), 'Message 2 transmited')
    subA2.once('data', chunk => {
      t.equal(chunk.toString('utf8'), msg3.toString('utf8'), 'Message 3 transmitted')
    })
    subA2.end(msg4, err => {
      t.error(err)
      t.ok(true, 'SubA2 local - Finish()')
      finish()
    })
  })

  subA1.write(msg1)
  subA2.write(msg2)
})

// TODO: requires hypercore to support extensions.
test.skip('Stresstest: Multiplexing channels', t => {
  const nCores = 300
  t.plan(1 + nCores * 8)
  let nready = nCores
  const feeds = Array.from(new Array(nCores))
    .map((_, i) => {
      const f = hypercore(ram)
      f.ready(() => {
        f.append(`feed_${i}`, err => {
          t.error(err, `testdata ${i} written`)
          if (!--nready) repl()
        })
      })
      return f
    })
  const key = Buffer.alloc(32)
  key.write('encryption secret')

  const stream1 = new Protocol(true)
  stream1.prefinalize.wait()

  const vfeed1 = stream1.feed(key)

  const stream2 = protocol({
    extensions: [substream.EXTENSION],
    live: true
  })
  const vfeed2 = stream2.feed(key)

  function repl () {
    let nfin = nCores
    feeds.forEach((localFeed, i) => {
      // Create local substream and replicate
      substream(vfeed1, localFeed.discoveryKey, (err, localSub) => {
        t.error(err, `local sub ${i} established`)
        if (err) return
        pump(localSub, localFeed.replicate(), localSub, err => {
          t.error(err, `successfully replicated local ${i}`)
        })
      })

      // Create remote substream and replicate then verify
      const remoteFeed = hypercore(ram, localFeed.key)
      substream(vfeed2, localFeed.discoveryKey, (err, remoteSub) => {
        t.error(err)
        pump(remoteSub, remoteFeed.replicate(), remoteSub, err => {
          t.error(err)
          remoteFeed.get(0, (err, rdata) => {
            t.error(err)
            localFeed.get(0, (err, ldata) => {
              t.error(err)
              t.ok(rdata.equals(ldata), `Data ${i} verified`)
              if (!--nfin) {
                stream2.end()
              }
            })
          })
        })
      })
    })
  }

  pump(stream1, stream2, stream1, err => {
    t.error(err)
    t.end() // end test when main streams end.
  })
})

test('duplicate namespace should throw NamespaceConflictError', t => {
  const key = Buffer.alloc(32)
  key.write('encryption secret')

  const peer1 = new PeerConnection(true, key, {
    onclose: t.error
  })
  const ext = peer1.registerExtension(new Substream())
  const sub1 = ext.open('dupe')
  sub1.once('error', t.error)
  t.ok(sub1)
  ext.open('dupe', (err, sub2) => {
    t.equal(err.type, 'NamespaceConflictError')
    t.notOk(sub2, 'Callback invoked')
    sub1.end()
    t.end()
  })
})
