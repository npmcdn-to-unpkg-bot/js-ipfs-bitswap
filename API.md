# API

## Public Methods

### `constructor(id, libp2p, datastore)`

- `id: PeerId`, the id of the local instance.
- `libp2p: Libp2p`, instance of the local network stack.
- `blockstore: Datastore`, instance of the local database (`IpfsRepo.blockstore`)

Create a new instance.


### `getStream()`

Returns a duplex `pull-stream`. Values written to it should be
the keys to fetch, and values emitted are the received blocks.
They results are not ordered in the same way as they are requested.

Example:

```js
pull(
  pull.values([key1, key2]),
  bitswap.getStream(),
  pull.collect((err, blocks) => {
    // blocks === [block1, block2]
  })
)
```

> Note: This is safe guarded so that the network is not asked
> for blocks that are in the local `datastore`.


### `unwantBlocks(keys)`

- `keys: []Multihash`

Cancel previously requested keys, forcefully. That means they are removed from the
wantlist independent of how many other resources requested these keys. Callbacks
attached to `getBlock` are errored with `Error('manual unwant: key')`.

### `cancelWants(keys)`

- `keys: []Multihash`

Cancel previously requested keys.


### `hasBlock(block, cb)`

- `block: IpfsBlock`
- `cb: Function`

Announce that the current node now has the `block`. This will store it
in the local database and attempt to serve it to all peers that are known
 to have requested it. The callback is called when we are sure that the block
 is stored.

### `wantlistForPeer(peerId)`

- `peerId: PeerId`

Get the wantlist for a given peer.

### `stat()`

Get stats about about the current state of the bitswap instance.
