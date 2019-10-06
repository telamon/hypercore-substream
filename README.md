# hypercore-substream

A hypercore extension that allows you to create and tunnel
virtual streams over a replication channel.


## Usage

```js
const hypercore = require('hypercore')
const SubstreamRouter = require('hypercore-substream')

// Setup two feeds and two vnets
const localFeed = hypercore(RAM)
const vnetA = localFeed.registerExtension(new SubstreamRouter())


const remoteFeed = hypercore(RAM, localFeed.key)
const vnetB = remoteFeed.registerExtension(new SubstreamRouter())

// Start replication
const replicationStream = localFeed.replicate(true, { live: true })
replicationStream
  .pipe(remoteFeed.replicate(false, { live: true }))
  .pipe(replicationStream)


// Open a substream by specifying identical namespace
const localSub = vnetA.open('nameofsub')
const remoteSub = vnetB.open('nameofsub')

remoteSub.on('data', chunk => console.log('Recv data:', chunk.toString())

// Connect event signals that both ends are ready
localSub.once('connect', () => {
  localSub.write('Hello Underworld!')
})
```

Should print
```
> Recv data: Hello Underworld
```

## API

### class: `SubstreamRouter`

`const vnet = core.registerExtension(new SubstreamRouter(opts = {}))`

The router is responsible for creating new and multiplexing existing substreams.

In order to be usable it needs to be passed through a `registerExtension()` method
by something that supports hypercore extensions.

**Handlers**

when initializing a new `SubstreamRouter` you can optionally pass
the following handlers:

- `opts.onsubdiscovery: function (namespace, peer)` Listen for new substreams
- `opts.onsubconnect: function(sub)` When a substream becomes established
- `opts.onsubclose: function(sub)` When a substream is closed



#### `vnet.open(namespace, opts = {}, callback)`

Creates new substreams

**Arguments**

- `namespace` a string or buffer identifying the channel.
- `opts` Object
  - `opts.timeout` Number signifying time to wait before HandshakeTimeoutError' is emitted
- `callback` optional `function (error, virtualStream)` If provided, will be called when stream becomes either active or fails to initialize.

**Returns**

a full-duplex node stream.

#### `Substream` event `connected`

Emitted when a connection has been established on both peer's ends.
Note: the sub stream is initialized in corked and paused state.
It is resumed and uncorked after the `connected` event has been fired.


## License

MIT
