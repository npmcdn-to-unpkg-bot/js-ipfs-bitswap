'use strict'

const IPFSRepo = require('ipfs-repo')
const path = require('path')
const ncp = require('ncp')
const rimraf = require('rimraf')
const fs = require('fs-blob-store')
const testRepoPath = path.join(__dirname, 'test-repo')
const async = require('async')

// book keeping
const repos = []

function createRepo (id, done) {
  const date = Date.now().toString()
  const repoPath = `${testRepoPath}-for-${date}-${id}`
  ncp(testRepoPath, repoPath, (err) => {
    if (err) return done(err)

    const repo = new IPFSRepo(repoPath, {stores: fs})
    repos.push(repoPath)
    done(null, repo)
  })
}

function removeRepos (done) {
  async.each(repos, (repo, cb) => {
    rimraf(repo, cb)
  }, done)
}

const repo = {
  create: createRepo,
  remove: removeRepos
}

require('./index-test')(repo)
require('./decision/engine-test')(repo)
require('./network/network.node.js')
require('./network/gen-bitswap-network.node.js')
