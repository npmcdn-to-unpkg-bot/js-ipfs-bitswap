'use strict'

const eachLimit = require('async/eachLimit')
const series = require('async/series')
const retry = require('async/retry')
const debug = require('debug')
const log = debug('bitswap')
log.error = debug('bitswap:error')
const EventEmitter = require('events').EventEmitter
const mh = require('multihashes')
const pull = require('pull-stream')
const merge = require('pull-merge')
const pushable = require('pull-pushable')

const cs = require('./constants')
const WantManager = require('./wantmanager')
const Network = require('./network')
const decision = require('./decision')

module.exports = class Bitwap {
  constructor (p, libp2p, blockstore, peerBook) {
    // the ID of the peer to act on behalf of
    this.self = p

    // the network delivers messages
    this.network = new Network(libp2p, peerBook, this)

    // local database
    this.blockstore = blockstore

    this.engine = new decision.Engine(blockstore, this.network)

    // handle message sending
    this.wm = new WantManager(this.network)

    this.blocksRecvd = 0
    this.dupBlocksRecvd = 0
    this.dupDataRecvd = 0

    this.notifications = new EventEmitter()
    this.notifications.setMaxListeners(cs.maxListeners)
  }

  // handle messages received through the network
  _receiveMessage (peerId, incoming, cb) {
    cb = cb || (() => {})
    log('receiving message from %s', peerId.toB58String())
    this.engine.messageReceived(peerId, incoming, (err) => {
      if (err) {
        log('failed to receive message', incoming)
      }

      const iblocks = incoming.blocks

      if (iblocks.size === 0) {
        return cb()
      }

      // quickly send out cancels, reduces chances of duplicate block receives
      const keys = []
      for (let block of iblocks.values()) {
        const found = this.wm.wl.contains(block.key)
        if (!found) {
          log('received un-askes-for %s from %s', mh.toB58String(block.key), peerId.toB58String())
        } else {
          keys.push(block.key)
        }
      }

      this.wm.cancelWants(keys)

      eachLimit(iblocks.values(), 10, (block, next) => {
        series([
          (innerCb) => this._updateReceiveCounters(block, (err) => {
            if (err) {
              // ignore, as these have been handled in _updateReceiveCounters
              return innerCb()
            }

            log('got block from %s', peerId.toB58String(), block.data.toString())
            innerCb()
          }),
          (innerCb) => this.hasBlock(block, (err) => {
            if (err) {
              log.error('receiveMessage hasBlock error: %s', err.message)
            }
            innerCb()
          })
        ], next)
      }, cb)
    })
  }

  _updateReceiveCounters (block, cb) {
    this.blocksRecvd ++
    this.blockstore.has(block.key, (err, has) => {
      if (err) {
        log('blockstore.has error: %s', err.message)
        return cb(err)
      }

      if (has) {
        this.dupBlocksRecvd ++
        this.dupDataRecvd += block.data.length
        return cb(new Error('Already have block'))
      }

      cb()
    })
  }

  _tryPutBlock (block, times, cb) {
    log('trying to put block %s', block.data.toString())
    retry({times, interval: 400}, (done) => {
      pull(
        pull.values([block]),
        this.blockstore.putStream(),
        pull.onEnd(done)
      )
    }, cb)
  }

  // handle errors on the receiving channel
  _receiveError (err) {
    log.error('ReceiveError: %s', err.message)
  }

  // handle new peers
  _onPeerConnected (peerId) {
    this.wm.connected(peerId)
  }

  // handle peers being disconnected
  _onPeerDisconnected (peerId) {
    this.wm.disconnected(peerId)
    this.engine.peerDisconnected(peerId)
  }

  // return the current wantlist for a given `peerId`
  wantlistForPeer (peerId) {
    return this.engine.wantlistForPeer(peerId)
  }

  getStream () {
    const unwantListeners = {}
    const blockListeners = {}
    const unwantEvent = (key) => `unwant:${key}`
    const blockEvent = (key) => `block:${key}`
    const pusher = pushable()

    let finished = false

    const finish = () => {
      if (finished && Object.keys(blockListeners).length === 0) {
        pusher.end()
      }
    }

    const cleanupListener = (key) => {
      const keyS = mh.toB58String(key)

      if (unwantListeners[keyS]) {
        this.notifications.removeListener(unwantEvent(keyS), unwantListeners[keyS])
        delete unwantListeners[keyS]
      }

      if (blockListeners[keyS]) {
        this.notifications.removeListener(blockEvent(keyS), blockListeners[keyS])
        delete blockListeners[keyS]
      }

      finish()
    }

    const addListener = (key) => {
      const keyS = mh.toB58String(key)
      unwantListeners[keyS] = () => {
        log(`manual unwant: ${keyS}`)
        cleanupListener(key)
      }

      blockListeners[keyS] = (block) => {
        pusher.push(block)
      }

      this.notifications.once(unwantEvent(keyS), unwantListeners[keyS])
      this.notifications.once(blockEvent(keyS), blockListeners[keyS])
    }

    const sink = pull(
      pull.asyncMap((key, cb) => {
        this.blockstore.has(key, (err, exists) => {
          cb(err, [key, exists])
        })
      }),
      pull.map((val) => {
        const key = val[0]
        const exists = val[1]
        if (exists) return key

        addListener(key)
        this.wm.wantBlocks([key])
      }),
      pull.filter(Boolean),
      pull.map((key) => this.blockstore.getStream(key)),
      pull.flatten(),
      pull.through((block) => {
        this.wm.cancelWants([block.key])
        pusher.push(block)
      }),
      pull.onEnd((err) => {
        finished = true
        if (err) return pusher.end(err)
        finish()
      })
    )

    const source = pull(
      pusher,
      pull.through((block) => cleanupListener(block.key))
    )

    return {source, sink}
  }

  // removes the given keys from the want list independent of any ref counts
  unwantBlocks (keys) {
    this.wm.unwantBlocks(keys)
    keys.forEach((key) => {
      this.notifications.emit(`unwant:${mh.toB58String(key)}`)
    })
  }

  // removes the given keys from the want list
  cancelWants (keys) {
    this.wm.cancelWants(keys)
  }

  // announces the existance of a block to this service
  hasBlock (block, cb) {
    cb = cb || (() => {})

    this._tryPutBlock(block, 4, (err) => {
      if (err) {
        log.error('Error writing block to blockstore: %s', err.message)
        return cb(err)
      }
      log('put block: %s', mh.toB58String(block.key))
      this.notifications.emit(`block:${mh.toB58String(block.key)}`, block)
      this.engine.receivedBlock(block)
      cb()
    })
  }

  getWantlist () {
    return this.wm.wl.entries()
  }

  stat () {
    return {
      wantlist: this.getWantlist(),
      blocksReceived: this.blocksRecvd,
      dupBlksReceived: this.dupBlocksRecvd,
      dupDataReceived: this.dupDataRecvd,
      peers: this.engine.peers()
    }
  }

  start () {
    this.wm.run()
    this.network.start()
    this.engine.start()
  }

  // Halt everything
  stop () {
    this.wm.stop()
    this.network.stop()
    this.engine.stop()
  }
}
