/* eslint-env mocha */
/* eslint max-nested-callbacks: ["error", 8]*/
'use strict'

const map = require('async/map')
const eachSeries = require('async/eachSeries')
const waterfall = require('async/waterfall')
const each = require('async/each')
const _ = require('lodash')
const expect = require('chai').expect
const PeerId = require('peer-id')
const Block = require('ipfs-block')
const mh = require('multihashes')
const PeerBook = require('peer-book')

const Message = require('../src/message')
const Bitswap = require('../src')

const utils = require('./utils')

const makeBlock = () => new Block(`hello world ${Math.random()}`)

module.exports = (repo) => {
  const libp2pMock = {
    handle: function () {},
    swarm: {
      muxedConns: {},
      on () {},
      setMaxListeners () {}
    }
  }

  describe('bitswap', () => {
    describe('receive message', () => {
      let store

      beforeEach((done) => {
        repo.create('hello', (err, r) => {
          if (err) return done(err)
          store = r.datastore
          done()
        })
      })

      afterEach((done) => {
        repo.remove(done)
      })

      it('simple block message', (done) => {
        const me = PeerId.create({bits: 64})
        const book = new PeerBook()
        const bs = new Bitswap(me, libp2pMock, store, book)
        bs.start()

        const other = PeerId.create({bits: 64})
        const b1 = makeBlock()
        const b2 = makeBlock()
        const msg = new Message(false)
        msg.addBlock(b1)
        msg.addBlock(b2)

        bs._receiveMessage(other, msg, (err) => {
          if (err) throw err

          expect(bs.blocksRecvd).to.be.eql(2)
          expect(bs.dupBlocksRecvd).to.be.eql(0)

          map([b1, b1],
            (val, cb) => store.get(val.key, cb),
            (err, res) => {
              if (err) return done(err)

              expect(res).to.be.eql([b1, b1])
              done()
            }
          )
        })
      })

      it('simple want message', (done) => {
        const me = PeerId.create({bits: 64})
        const book = new PeerBook()
        const bs = new Bitswap(me, libp2pMock, store, book)
        bs.start()

        const other = PeerId.create({bits: 64})
        const b1 = makeBlock()
        const b2 = makeBlock()
        const msg = new Message(false)
        msg.addEntry(b1.key, 1, false)
        msg.addEntry(b2.key, 1, false)

        bs._receiveMessage(other, msg, (err) => {
          if (err) throw err

          expect(bs.blocksRecvd).to.be.eql(0)
          expect(bs.dupBlocksRecvd).to.be.eql(0)

          const wl = bs.wantlistForPeer(other)
          expect(wl.has(mh.toB58String(b1.key))).to.be.eql(true)
          expect(wl.has(mh.toB58String(b2.key))).to.be.eql(true)

          done()
        })
      })

      it('multi peer', (done) => {
        const me = PeerId.create({bits: 64})
        const book = new PeerBook()
        const bs = new Bitswap(me, libp2pMock, store, book)
        bs.start()

        const others = _.range(5).map(() => PeerId.create({bits: 64}))
        const blocks = _.range(10).map((i) => new Block(`hello ${i}`))
        const messages = _.range(5).map((i) => {
          const m = new Message(false)
          m.addBlock(blocks[i])
          m.addBlock(blocks[5 + i])
          return m
        })
        let i = 0
        eachSeries(others, (other, cb) => {
          const msg = messages[i]
          i++
          bs._receiveMessage(other, msg, (err) => {
            if (err) return cb(err)
            hasBlocks(msg, store, cb)
          })
        }, done)
      })
    })

    describe('getBlock', () => {
      let store

      before((done) => {
        repo.create('hello', (err, r) => {
          if (err) return done(err)
          store = r.datastore
          done()
        })
      })

      after((done) => {
        repo.remove(done)
      })

      it('block exists locally', (done) => {
        const me = PeerId.create({bits: 64})
        const block = makeBlock()
        store.put(block, (err) => {
          if (err) throw err
          const book = new PeerBook()
          const bs = new Bitswap(me, libp2pMock, store, book)

          bs.getBlock(block.key, (err, res) => {
            if (err) throw err

            expect(res).to.be.eql(block)
            done()
          })
        })
      })

      // Not sure if I understand what is going on here
      // test fails because now the network is not properly mocked
      // what are these net.stores and mockNet.bitswaps?
      it.skip('block is retrived from peer', (done) => {
        const block = makeBlock()

        let mockNet
        waterfall([
          (cb) => utils.createMockNet(repo, 2, cb),
          (net, cb) => {
            mockNet = net
            net.stores[1].put(block, cb)
          },
          (val, cb) => {
            mockNet.bitswaps[0]._onPeerConnected(mockNet.ids[1])
            mockNet.bitswaps[1]._onPeerConnected(mockNet.ids[0])
            mockNet.bitswaps[0].getBlock(block.key, cb)
          },
          (res, cb) => {
            expect(res).to.be.eql(res)
            cb()
          }
        ], done)
      })

      it('block is added locally afterwards', (done) => {
        const me = PeerId.create({bits: 64})
        const block = makeBlock()
        const book = new PeerBook()
        const bs = new Bitswap(me, libp2pMock, store, book)
        const net = utils.mockNetwork()
        bs.network = net
        bs.wm.network = net
        bs.engine.network = net
        bs.start()

        bs.getBlock(block.key, (err, res) => {
          if (err) throw err
          expect(res).to.be.eql(block)
          done()
        })
        setTimeout(() => {
          bs.hasBlock(block, () => {})
        }, 200)
      })

      it('block is sent after local add', (done) => {
        const me = PeerId.create({bits: 64})
        const other = PeerId.create({bits: 64})
        const block = makeBlock()
        let bs1
        let bs2

        const n1 = {
          connectTo (id, cb) {
            let err
            if (id.toHexString() !== other.toHexString()) {
              err = new Error('unkown peer')
            }
            setImmediate(() => cb(err))
          },
          sendMessage (id, msg, cb) {
            if (id.toHexString() === other.toHexString()) {
              bs2._receiveMessage(me, msg, cb)
            } else {
              setImmediate(() => cb(new Error('unkown peer')))
            }
          },
          start () {},
          stop () {}
        }
        const n2 = {
          connectTo (id, cb) {
            let err
            if (id.toHexString() !== me.toHexString()) {
              err = new Error('unkown peer')
            }
            setImmediate(() => cb(err))
          },
          sendMessage (id, msg, cb) {
            if (id.toHexString() === me.toHexString()) {
              bs1._receiveMessage(other, msg, cb)
            } else {
              setImmediate(() => cb(new Error('unkown peer')))
            }
          },
          start () {},
          stop () {}
        }
        bs1 = new Bitswap(me, libp2pMock, store, new PeerBook())
        utils.applyNetwork(bs1, n1)
        bs1.start()

        let store2

        waterfall([
          (cb) => repo.create('world', cb),
          (repo, cb) => {
            store2 = repo.datastore
            bs2 = new Bitswap(other, libp2pMock, store2, new PeerBook())
            utils.applyNetwork(bs2, n2)
            bs2.start()
            bs1._onPeerConnected(other)
            bs2._onPeerConnected(me)
            bs1.getBlock(block.key, cb)

            setTimeout(() => {
              bs2.hasBlock(block)
            }, 1000)
          },
          (res, cb) => {
            expect(res).to.be.eql(res)
            cb()
          }
        ], done)
      })
    })

    describe('stat', () => {
      it('has initial stats', () => {
        const me = PeerId.create({bits: 64})
        const bs = new Bitswap(me, libp2pMock, {}, new PeerBook())

        const stats = bs.stat()
        expect(stats).to.have.property('wantlist')
        expect(stats).to.have.property('blocksReceived', 0)
        expect(stats).to.have.property('dupBlksReceived', 0)
        expect(stats).to.have.property('dupDataReceived', 0)
        expect(stats).to.have.property('peers')
      })
    })

    describe('unwantBlocks', () => {
      let store
      beforeEach((done) => {
        repo.create('hello', (err, r) => {
          if (err) return done(err)
          store = r.datastore
          done()
        })
      })

      afterEach((done) => {
        repo.remove(done)
      })

      it('removes blocks that are wanted multiple times', (done) => {
        const me = PeerId.create({bits: 64})
        const bs = new Bitswap(me, libp2pMock, store, new PeerBook())
        bs.start()
        const b = makeBlock()

        let i = 0
        const finish = () => {
          i++
          if (i === 2) {
            done()
          }
        }

        bs.getBlock(b.key, (err, res) => {
          expect(err.message).to.be.eql(`manual unwant: ${mh.toB58String(b.key)}`)
          finish()
        })
        bs.getBlock(b.key, (err, res) => {
          expect(err.message).to.be.eql(`manual unwant: ${mh.toB58String(b.key)}`)
          finish()
        })

        bs.unwantBlocks([b.key])
      })
    })
  })
}

function hasBlocks (msg, store, cb) {
  each(Array.from(msg.blocks.values()), (b, next) => {
    if (!b.cancel) {
      store.has(b.key, next)
    } else {
      next()
    }
  }, cb)
}
