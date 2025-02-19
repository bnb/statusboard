require('dotenv').config()

const repositories = require('../public/data/maintained.json')

const fs = require('fs')
const path = require('path')
const mkdirp = require('mkdirp')
const dateFns = require('date-fns')

const api = require('../api')

const { sleep } = require('sleepover')

const exec = async () => {

  /**
   * We split up the iteration twice in order to compensate for having to use the `sleep` library.
   * The throttling plugin does not work for paginated calls that use the search api.
   */
  const repoIssuesMap = {}
  try {
    let completed = 0
    const total = repositories.length
    console.log(`Requesting issue data for ${total} repositories.`)
    for (const { repository } of repositories) {
      const [owner, name] = repository.split('/').slice(-2)
      const noLabel = await api.getNoLabelIssues(owner, name)
      await sleep(500)
      const highPriority = await api.getRepoIssues(owner, name, 'Priority 1')
      await sleep(250)
      const needsTriage = await api.getRepoIssues(owner, name, 'Needs Triage')
      repoIssuesMap[`${owner}/${name}`] = {
        noLabel: noLabel.length,
        highPriority: highPriority.length,
        needsTriage: needsTriage.length
      }
      completed++
      console.log(`completed: ${completed} / ${total}`)
    }
  } catch (error) {
    console.log(error)
  }

  try {
    const promises = repositories.map(async (repo) => {
      try {
        const [owner, name] = repo.repository.split('/').slice(-2)
        const { data: repoData } = await api.getRepo(owner, name)
        const result = {
          ...repoData,
          owner,
          name,
          coverage: '',
          coverageLevel: '',
          pkg: {},
          last_publish: null,
          downloads: 0,
          node: null,
          template_version: null,
          high_priority_issues_count: NaN,
          needs_triage_issues_count: NaN,
          no_label_issues_count: NaN,
        }

        const prs = await api.getPullRequests(owner, name)
        result.prs_count = prs.length
        result.issues_count = repoData.open_issues_count - prs.length,
        result.pushed_at_diff = dateFns.formatDistanceToNow(new Date(repoData.pushed_at), {
          addSuffix: false,
          includeSeconds: false
        })

        const checkRuns = await api.getCheckRuns(
          owner,
          name,
          repoData.default_branch
        )
        result.check_runs = checkRuns.map(run => run.conclusion)

        console.log(`Fetching coverage: https://coveralls.io/github/${owner}/${name}.json`)

        const coveralls = await api.getCoveralls(owner, name)

        if (coveralls) {
          result.coverage = Math.round(coveralls.covered_percent)
          if (result.coverage === 100) {
            result.coverageLevel = 'high'
          } else if (result.coverage > 80) {
            result.coverageLevel = 'medium'
          } else {
            result.coverageLevel = 'low'
          }
        }

        if (repo.package) {
          result.package = repo.package
          console.log(`Fetching packument and manifest for ${repo.package}`)
          result.pkg = await api.getManifest(repo.package)
          result.node = result.pkg.engines && result.pkg.engines.node || null
          result.version = result.pkg.version || null
          result.template_version = result.pkg.templateVersion || null

          const packument = await api.getPackument(repo.package)

          if (packument.modified) {
            result.last_publish = dateFns.formatDistanceToNow(new Date(packument.modified), {
              addSuffix: false,
              includeSeconds: false
            })
          }

          console.log(
            'Fetching downloads:',
            `https://api.npmjs.org/downloads/point/last-month/${repo.package}`
          )
          const downloads = await api.getDownloads(repo.package)
          if (downloads) {
            result.downloads = downloads.downloads || 0
          }
        }


        result.license = { key: ''}
        if (result.pkg.license) {
          result.license.key = result.pkg.license
        } else if (repo.license) {
          result.license.key = repo.license.spdx_id
        }

        const issues = repoIssuesMap[`${owner}/${name}`]

        if (issues) {
          result.high_priority_issues_count = issues.highPriority
          result.needs_triage_issues_count = issues.needsTriage
          result.no_label_issues_count = issues.noLabel
        }

        return result
      } catch (error) {
        console.error(error)
      }
    })

    let result = await Promise.all(promises)
    result = {
      data: result.filter((r) => !!r),
      created_at: new Date().toISOString()
    }

    const now = new Date()
    const month = String('00' + (now.getUTCMonth() + 1)).slice(-2)
    const dir = path.join('..', 'public', 'data', String(now.getUTCFullYear()), month)
    await mkdirp(path.resolve(__dirname, dir))
    const dest = path.join(dir, `${now.getUTCDate()}.json`)
    fs.writeFileSync(path.resolve(__dirname, dest), JSON.stringify(result.data), 'utf8')

    const latestJSON = path.join('..', 'public', 'data', 'latest.json')
    fs.writeFileSync(path.resolve(__dirname, latestJSON), JSON.stringify(result), 'utf8')
  } catch (error) {
    console.log(error)
  }
}

exec()
