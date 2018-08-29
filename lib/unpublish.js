/* eslint-disable standard/no-callback-literal */
'use strict'

module.exports = unpublish

const BB = require('bluebird')

const eu = encodeURIComponent
const figgyPudding = require('figgy-pudding')
const libaccess = require('libnpmaccess')
const log = require('npmlog')
const npa = require('npm-package-arg')
const npm = require('./npm.js')
const npmConfig = require('./config/figgy-config.js')
const npmFetch = require('npm-registry-fetch')
const otplease = require('./utils/otplease.js')
const output = require('./utils/output.js')
const path = require('path')
const readJson = BB.promisify(require('read-package-json'))
const semver = require('semver')
const url = require('url')
const usage = require('./utils/usage.js')
const whoami = BB.promisify(require('./whoami.js'))

unpublish.usage = usage('npm unpublish [<@scope>/]<pkg>[@<version>]')

function UsageError () {
  throw Object.assign(new Error(`Usage: ${unpublish.usage}`), {
    code: 'EUSAGE'
  })
}

const UnpublishConfig = figgyPudding({
  force: {},
  loglevel: {},
  silent: {}
})

unpublish.completion = function (cliOpts, cb) {
  if (cliOpts.conf.argv.remain.length >= 3) return cb()

  whoami([], true).then(username => {
    if (!username) { return [] }
    const opts = UnpublishConfig(npmConfig())
    return libaccess.lsPackages(username, opts).then(access => {
      // do a bit of filtering at this point, so that we don't need
      // to fetch versions for more than one thing, but also don't
      // accidentally a whole project.
      let pkgs = Object.keys(access)
      if (!cliOpts.partialWord || !pkgs.length) { return pkgs }
      const pp = npa(cliOpts.partialWord).name
      pkgs = pkgs.filter(p => !p.indexOf(pp))
      if (pkgs.length > 1) return pkgs
      return npmFetch.json(npa(pkgs[0]).escapedName, opts).then(doc => {
        const vers = Object.keys(doc.versions)
        if (!vers.length) {
          return pkgs
        } else {
          return vers.map(v => `${pkgs[0]}@${v}`)
        }
      })
    })
  }).nodeify(cb)
}

function unpublish (args, cb) {
  if (args.length > 1) return cb(unpublish.usage)

  const spec = args.length && npa(args[0])
  const opts = UnpublishConfig(npmConfig())
  const version = spec.rawSpec
  BB.try(() => {
    log.silly('unpublish', 'args[0]', args[0])
    log.silly('unpublish', 'spec', spec)
    if (!version && !opts.force) {
      throw Object.assign(new Error(
        'Refusing to delete entire project.\n' +
        'Run with --force to do this.\n' +
        unpublish.usage
      ), {code: 'EUSAGE'})
    }
    if (!spec || path.resolve(spec.name) === npm.localPrefix) {
      // if there's a package.json in the current folder, then
      // read the package name and version out of that.
      const cwdJson = path.join(npm.localPrefix, 'package.json')
      return readJson(cwdJson).then(data => {
        log.verbose('unpublish', data)
        return gotProject(npa(data.name), data.version, opts.concat(data.publishConfig))
      }, err => {
        if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
          throw err
        } else {
          UsageError()
        }
      })
    } else {
      return gotProject(spec, version, opts)
    }
  }).then(
    ret => cb(null, ret),
    err => err.code === 'EUSAGE' ? cb(err.message) : cb(err)
  )
}

function gotProject (spec, version, opts) {
  const pkgUri = spec.escapedName
  return npmFetch.json(pkgUri, opts.concat({
    query: { write: true }
  })).then(pkg => {
    if (!version) {
      log.info('unpublish', 'No version specified, removing all')
      return otplease(opts, opts => {
        return npmFetch(`/${pkgUri}/-rev/${pkg._rev}`, opts.concat({
          method: 'DELETE',
          ignoreBody: true
        }))
      })
    } else {
      const allVersions = pkg.versions || {}
      const versionPublic = allVersions.hasOwnProperty(version)
      let dist
      if (!versionPublic) {
        log.info(
          'unpublish', spec.name + '@' + version + ' not published'
        )
      } else {
        dist = allVersions[version].dist
        log.verbose('unpublish', 'removing attachments for', dist)
      }
      delete allVersions[version]
      // if it was the only version, then delete the whole package.
      if (!Object.keys(allVersions).length) {
        log.info(
          'unpublish', 'No versions remain, removing entire package'
        )
        return otplease(opts, opts => {
          return npmFetch(`/${pkgUri}/-rev/${pkg._rev}`, opts.concat({
            method: 'DELETE',
            ignoreBody: true
          }))
        })
      } else if (versionPublic) {
        const latestVer = pkg['dist-tags'].latest
        Object.keys(pkg['dist-tags']).forEach(tag => {
          if (pkg['dist-tags'][tag] === version) {
            delete pkg['dist-tags'][tag]
          }
        })

        if (latestVer === version) {
          pkg['dist-tags'].latest = Object.keys(
            allVersions
          ).sort(semver.compareLoose).pop()
        }

        delete pkg._revisions
        delete pkg._attachments
        // Update packument with removed versions
        return otplease(opts, opts => {
          return npmFetch(`/${pkgUri}/-rev/${pkg._rev}`, opts.concat({
            method: 'PUT',
            body: pkg,
            ignoreBody: true
          }))
        }).then(() => {
          // Remove the tarball itself
          if (!dist || !dist.tarball) { return }
          return npmFetch.json(pkgUri, opts.concat({
            query: { write: true }
          })).then(({_rev, _id}) => {
            if (!_rev) {
              throw new Error(`No _rev found in ${_id}`)
            } else {
              const tarballUrl = url.parse(dist.tarball).pathname
              return otplease(opts, opts => {
                return npmFetch(`/${tarballUrl}/-rev/${_rev}`, opts.concat({
                  method: 'DELETE',
                  ignoreBody: true
                }))
              })
            }
          })
        })
      }
    }
  }, err => {
    if (err.code === 'E404') {
      log.info('unpublish', `${spec} is not published or visible.`)
    } else {
      throw err
    }
  }).then(() => {
    if (!opts.silent && opts.loglevel !== 'silent') {
      output('- ' + spec.name + (version ? '@' + version : ''))
    }
  })
}
