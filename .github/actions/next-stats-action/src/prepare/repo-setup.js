const path = require('path')
const fs = require('fs-extra')
const exec = require('../util/exec')
const { remove } = require('fs-extra')
const logger = require('../util/logger')
const semver = require('semver')

const mockTrace = () => ({
  traceAsyncFn: (fn) => fn(mockTrace()),
  traceChild: () => mockTrace(),
})

module.exports = (actionInfo) => {
  return {
    async cloneRepo(repoPath = '', dest = '') {
      await remove(dest)
      await exec(`git clone ${actionInfo.gitRoot}${repoPath} ${dest}`)
    },
    async checkoutRef(ref = '', repoDir = '') {
      await exec(`cd ${repoDir} && git fetch && git checkout ${ref}`)
    },
    async getLastStable(repoDir = '', ref) {
      const { stdout } = await exec(`cd ${repoDir} && git tag -l`)
      const tags = stdout.trim().split('\n')
      let lastStableTag

      for (let i = tags.length - 1; i >= 0; i--) {
        const curTag = tags[i]
        // stable doesn't include `-canary` or `-beta`
        if (!curTag.includes('-') && !ref.includes(curTag)) {
          if (!lastStableTag || semver.gt(curTag, lastStableTag)) {
            lastStableTag = curTag
          }
        }
      }
      return lastStableTag
    },
    async getCommitId(repoDir = '') {
      const { stdout } = await exec(`cd ${repoDir} && git rev-parse HEAD`)
      return stdout.trim()
    },
    async resetToRef(ref = '', repoDir = '') {
      await exec(`cd ${repoDir} && git reset --hard ${ref}`)
    },
    async mergeBranch(ref = '', origRepoDir = '', destRepoDir = '') {
      await exec(`cd ${destRepoDir} && git remote add upstream ${origRepoDir}`)
      await exec(`cd ${destRepoDir} && git fetch upstream`)

      try {
        await exec(`cd ${destRepoDir} && git merge upstream/${ref}`)
        logger('Auto merge of main branch successful')
      } catch (err) {
        logger.error('Failed to auto merge main branch:', err)

        if (err.stdout && err.stdout.includes('CONFLICT')) {
          await exec(`cd ${destRepoDir} && git merge --abort`)
          logger('aborted auto merge')
        }
      }
    },
    async linkPackages({ repoDir = '', nextSwcPkg, parentSpan }) {
      const rootSpan = parentSpan
        ? parentSpan.traceChild('linkPackages')
        : mockTrace()

      let origRepo = path.join(__dirname, '..', '..', '..', '..', '..')

      // stats-action runs this code without access to the original repo.
      // So repoDir is the only version taht we have
      if (origRepo === '/') {
        origRepo = repoDir
      }

      const turboCacheLocation = path.join(
        origRepo,
        'node_modules',
        '.cache',
        'turbo'
      )
      const packedPkgsDir = path.join(
        origRepo,
        'node_modules',
        '.cache',
        'tests',
        'packed-pkgs'
      )

      return await rootSpan.traceAsyncFn(async () => {
        const pkgPaths = new Map()
        const pkgDatas = new Map()
        let pkgs

        try {
          pkgs = await fs.readdir(path.join(repoDir, 'packages'))
        } catch (err) {
          if (err.code === 'ENOENT') {
            require('console').log('no packages to link')
            return pkgPaths
          }
          throw err
        }

        await rootSpan
          .traceChild('prepare packages for packing')
          .traceAsyncFn(async () => {
            await fs.ensureDir(packedPkgsDir)
            const repoData = require(path.join(repoDir, 'package.json'))

            for (const pkg of pkgs) {
              const pkgPath = path.join(repoDir, 'packages', pkg)
              const pkgSrcPath = path.join(origRepo, 'packages', pkg)
              const packedPkgPath = path.join(
                packedPkgsDir,
                `${pkg}-packed.tgz`
              )

              const pkgDataPath = path.join(pkgPath, 'package.json')
              if (!fs.existsSync(pkgDataPath)) {
                require('console').log(`Skipping ${pkgDataPath}`)
                continue
              }
              const pkgData = require(pkgDataPath)
              const { name } = pkgData
              pkgDatas.set(name, {
                pkgDataPath,
                pkg,
                pkgPath,
                pkgSrcPath,
                pkgData,
                packedPkgPath,
              })
              pkgPaths.set(name, packedPkgPath)
            }

            for (const pkg of pkgDatas.keys()) {
              const {
                pkgDataPath,
                pkgData,
                pkgPath,
                packedPkgPath,
                pkgSrcPath,
              } = pkgDatas.get(pkg)

              for (const depPkg of pkgDatas.keys()) {
                const dep = pkgDatas.get(depPkg)
                if (!pkgData.dependencies || !pkgData.dependencies[depPkg])
                  continue
                pkgData.dependencies[depPkg] = dep.packedPkgPath
              }

              // make sure native binaries are included in local linking
              if (pkg === '@next/swc') {
                if (!pkgData.files) {
                  pkgData.files = []
                }
                pkgData.files.push('native')
                const binariesPath = path.join(pkgPath, 'native')
                require('console').log(
                  'using swc binaries: ',
                  await exec(`ls ${binariesPath}`)
                )
              }

              if (pkg === 'next') {
                if (nextSwcPkg) {
                  Object.assign(pkgData.dependencies, nextSwcPkg)
                } else {
                  if (pkgDatas.get('@next/swc')) {
                    pkgData.dependencies['@next/swc'] =
                      pkgDatas.get('@next/swc').packedPkgPath
                  } else {
                    pkgData.files.push('native')
                  }
                }
              }

              // Turbo requires package manager specification
              pkgData.packageManager =
                pkgData.packageManager || repoData.packageManager

              pkgData.scripts = {
                ...pkgData.scripts,
                'test-pack': `yarn pack -f ${packedPkgPath}`,
              }

              const turboConfig = {
                pipeline: {
                  'test-pack': {
                    outputs: [packedPkgPath],
                    inputs: [pkgSrcPath],
                  },
                },
              }
              if (pkg === 'next') {
                console.log(JSON.stringify(turboConfig, null, 2))

                console.log(
                  String(
                    fs.readFileSync(path.join(pkgPath, 'src/pages/_app.tsx'))
                  )
                )
              }
              await fs.writeJSON(path.join(pkgPath, 'turbo.json'), turboConfig)
              // Turbo requires pnpm-lock.yaml that is not empty
              await fs.writeFile(path.join(pkgPath, 'pnpm-lock.yaml'), '')

              await fs.writeFile(
                pkgDataPath,
                JSON.stringify(pkgData, null, 2),
                'utf8'
              )
            }
          })

        // wait to pack packages until after dependency paths have been updated
        // to the correct versions
        await rootSpan
          .traceChild('packing packages')
          .traceAsyncFn(async (packingSpan) => {
            await Promise.all(
              Array.from(pkgDatas.keys()).map(async (pkgName) => {
                await packingSpan
                  .traceChild(`pack ${pkgName}`)
                  .traceAsyncFn(async () => {
                    const { pkgPath } = pkgDatas.get(pkgName)
                    const result = await exec(
                      `pnpm run --dir="${origRepo}" turbo run test-pack --cache-dir="${turboCacheLocation}" --cwd="${pkgPath}" -vvv`,
                      true
                    )
                    if (pkgName === 'next') {
                      console.log(result)
                    }
                  })
              })
            )
          })

        return pkgPaths
      })
    },
  }
}
