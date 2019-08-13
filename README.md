# hypercore-protocol-substream

Independent virtual streams through a hypercore-protocol stream


## Usage
```js
const substream = require('hypercore-protocol-substream')
const protocol = require('hypercore-protocol')
const hypercore = require('hyprecore')

const core = hypercore(storage, key)

// Register the substream proto-extension
const stream = core.replicate({ extensions: [substream.EXTENSION] })

// Initialize new virtual stream as namespace 'beef'
const virt1 = substream(stream, 'beef')

// Connected event is fired when a virtual stream with the same
// namespace have been initialized on the remote end.
virt1.on('connected', (virt1) => {
  virt1.write('Hello remote!')
})

// A virtual stream is a regular full-duplex stream
virt1.on('data', console.log)
virt1.on('error', console.error)
virt1.on('end', console.log('Stream has ended'))

// Ending the stream in one end, also signals end to the remote.
virt1.end('bye bye')


// Alternative initializer
substream(stream, 'second', (err, virtual2) => { // on connect
  if (err) throw err
  const replStream = core.replicate({ live: true })
  replStream.pipe(virtual2).pipe(replStream) // replicate as usual.
})


// Once you've initiated a hypercore-protocol stream with substream's extension
// You can listen for incoming streams without any knowledge of the namespace.

const connectionHandler = (namespace) => {
  if (namespace == 'Awsomechat') {
    const virtual3 = substream(stream, namespace)
    virtual3.end('Hey!')
  }
}

stream.on('substream-discovered', connectionHandler)
stream.once('end', () => stream.off('substream-discovered', connectionHandler))

/*
 * Alternatively initialize a hyperprotocol-stream manually
 */
const key = Buffer.alloc(32)
key.write('encryption secret')
const stream2 = protocol({extensions: [substream.EXTENSION]})
const vFeed = protocol.feed(key) // a main feed needs to be initialized manually

const vitual4 = substream(stream2, 'foo')
```

## API

#### `substream(stream, namespace, opts, callback')`

`stream` a hypercore-protocol stream

`namespace` a buffer, keep it short if possible, as it produces overhead on
your data.

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
