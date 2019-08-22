# hypercore-protocol-substream

Independent virtual streams through a hypercore-protocol stream


## Usage

#### Dedicated primary feed for communication

Creating a substream through a manually instantiated `hypercore-protocol`
instance.

```js
const substream = require('hypercore-protocol-substream')
const protocol = require('hypercore-protocol')

// Any buffer will effectively do for encryption
const key = Buffer.alloc(32)
key.write('encryption secret')

// Create a protocol stream with the substream extension
const stream = protocol({extensions: [substream.EXTENSION]})


// Create a primary feed with an encryption key
const virtualFeed = stream.feed(key)

// Initialize new virtual stream as namespace 'beef'
const sub1 = substream(virtualFeed, 'beef')

// 'connected' event is fired when a virtual stream with the same
// namespace have been initialized on the remote end.
sub1.on('connected', (sub1) => {
  sub1.write('Hello remote!')
})

// A virtual stream is a regular full-duplex stream
sub1.on('data', console.log)
sub1.on('error', console.error)

// Ending the stream in one end, also signals end to the remote.
sub1.end('bye bye')

// Create another substream using callback-style initializer
substream(virtualFeed, 'pictures', (error, sub2) => {
  if (error) throw error

  const core = hypercore(ram)

  core.ready(() => {
    // cores can be replicated transparently through a substream tunnel
    sub2.pipe(core.replicate()).pipe(sub2)
  })

  // Hypercore 'finished' events can be caught using the substream 'end' event.
  sub2.on('end', err => {
    if (err) throw err
    else console.log('Core replicated through substream successfully')
  })
})


// Don't forget to connect the main stream to a valid endpoint
stream.pipe(remotePeerStream).pipe(stream)
```

#### Using an existing feed for communication

Alternatively you can piggyback onto another core's replication stream
as long as it supports forwarding the `extensions` hypercore-protocol option
on it's `replicate()` method.

But you will also need to tell the hypercore replication stream to stay open
after it finished it's own replication, either by opening it in `live` mode
or incrementing the `stream.expectedFeeds`

```js
const realCore = hypercore(ram)

realCore.ready(() => {
  // create a replication stream that won't prematurely close
  // and has our extension registered
  const stream = realCore.replicate({ live: true, extensions: [substream.EXTENSION] })

  // Hijack the primary feed from the stream.
  // (a cleaner way should be possible)
  const primary = stream.feeds[0]

  // create substreams on the hijacked feed
  substream(primary, 'piggyback', (err, virtual) => {
    if (err) throw err

    const drive = hyperdrive(ram)
    drive.ready(() => {
        virtual.pipe(drive.replicate()).pipe(virtual)
    })

    // Signal to close the real stream when our sub is done.
    virtual.on('end', err => stream.end(end))
  })

})

```

#### Listening for incoming substreams

Once you have an initialize hypercore-protocol `stream` with
the substream router installed.

You can listen for incoming streams without any prior knowledge of the namespace.

```js
const connectionHandler = (namespace) => {
  if (namespace == 'Awsomechat') {
    substream(virtualFeed, namespace, (err, sub) => {
      sub.end('I like awesome topics!')
    })
  }
}

stream.on('substream-discovered', connectionHandler)
stream.once('end', () => stream.off('substream-discovered', connectionHandler))
```
( Please open an issue if you're interested in formalizing this feature, I'm not
intending to use this myself right now. )


## API

#### `substream(protofeed, namespace, opts, callback')`

`protofeed` A hypercore-protocol [feed
instance](https://github.com/mafintosh/hypercore-protocol/blob/master/feed.js)
or compatible that supports listening on
[`extension` events](https://github.com/mafintosh/hypercore-protocol#feedonextension-name-message) and sending extensions messages through [`extension(name, data)`](https://github.com/mafintosh/hypercore-protocol#feedextensionname-message)

`namespace` a string or buffer identifying the channel.

`opts` Object
```js
  {
    timeout: 5000 // Time to wait for remote to answer the call.
                  // causes 'HandshakeTimeoutError' error to be emitted
  }
```

`callback` optional `function (error, virtualStream)`

If provided, will be called when stream becomes either
active or fails to initialize.

#### `VirtualStream` event `connected`

Emitted when a connection has been established on both peer's ends.
Note: the sub stream is initialized in corked and paused state.
It is resumed and uncorked after the `connected` event has been fired.


#### `MainStream` event `substream-discovered`

Once your main stream has been initialized with the extension
`substream.EXTENSION` - the `substream-discovered` event will be fired
whenever a remote peer sends a `handshake`

#### `MainStream` event `substream-connected`

Once your main stream has been initialized with the extension
`substream.EXTENSION` - the `substream-connected` event will be fired
whenever a virtual stream enters state `ESTABLISHED`


#### `MainStream` event `substream-disconnected`

Once your main stream has been initialized with the extension
`substream.EXTENSION` - the `substream-connected` event will be fired
whenever an active virtual stream is disconnected either on your or the remote's
end.


## License

MIT
