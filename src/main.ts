import * as core from '@actions/core'
import * as github from '@actions/github'
import {existsSync, readFileSync} from 'fs'
import COS from 'cos-nodejs-sdk-v5'

const githubToken = core.getInput('token', {required: true})
const branch = core.getInput('branch', {required: true})
const secretId = core.getInput('secretId', {required: true})
const secretKey = core.getInput('secretKey', {required: true})
const bucket = core.getInput(core.getInput('bucket', {required: true}))
const region = core.getInput(core.getInput('region', {required: true}))
const subPath = core.getInput('subPath', {required: true})

const cos = new COS({
  SecretId: secretId,
  SecretKey: secretKey
})

async function run(): Promise<void> {
  try {
    /**
     * read .syncignore
     */
    let filters: RegExp[] = []
    if (existsSync('.syncignore')) {
      const ignoreContent = readFileSync('.syncignore', {encoding: 'utf-8'})
      filters = ignoreContent.split('\n').map(i => new RegExp(i))
    }

    /**
     * get last commit file
     */
    const client = github.getOctokit(githubToken)
    const result = await client.rest.repos.getCommit({
      ...github.context.repo,
      ref: branch
    })

    if (result.status !== 200 || !result.data.files) {
      throw new Error(JSON.stringify(result))
    }
    const files = result.data.files.filter(
      i => !filters.some(j => j.test(i.filename))
    )

    core.debug(`need processd files: \n
    ${files.map(i => `${i.filename}: ${i.status}`).join('\n')}
    `)

    /**
     * process file
     */
    for (const file of files) {
      switch (file.status) {
        case 'removed':
          cos.deleteObject(
            {
              Bucket: bucket,
              Region: region,
              Key: `${subPath}/${file.filename}`
            },
            err => {
              if (err) {
                core.debug(err.message)
              } else {
                core.debug(`${file.filename} deleted`)
              }
            }
          )
          break
        case 'added':
        case 'modified':
          cos.uploadFile(
            {
              Bucket: bucket,
              Region: region,
              FilePath: file.filename,
              Key: `${subPath}/${file.filename}`,
              SliceSize: 1024 * 1024 * 5
            },
            err => {
              if (err) {
                core.debug(err.message)
              } else {
                core.debug(`${file.filename} uploaded`)
              }
            }
          )
          break
        case 'renamed':
          cos.putObjectCopy(
            {
              Bucket: bucket,
              Region: region,
              Key: `${subPath}/${file.filename}`,
              CopySource: `${bucket}.cos.${region}.myqcloud.com/${subPath}/${file.previous_filename}`
            },
            err => {
              if (err) {
                core.debug(err.message)
              } else {
                cos.deleteObject(
                  {
                    Bucket: bucket,
                    Region: region,
                    Key: `${subPath}/${file.filename}`
                  },
                  delErr => {
                    if (delErr) {
                      core.debug(delErr.message)
                    } else {
                      core.debug(`${file.filename} moved`)
                    }
                  }
                )
              }
            }
          )
          break
        default:
          core.debug(`do not process ${file.filename} ${file.status}`)
          break
      }
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
