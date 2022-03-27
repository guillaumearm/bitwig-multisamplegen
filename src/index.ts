#!/usr/bin/env node

import execa from 'execa'
import ora from 'ora'
import inquirer from 'inquirer'

export const query = async () => {
  const info = await inquirer.prompt([
    {
      type: 'input',
      name: 'cmd',
      message: 'Input the script command you want to execute : ',
      validate: (cmd: string) => {
        return cmd?.length > 0
      },
      default: 'start'
    }
  ])
  return info
}

const app = async () => {
  const { cmd } = await query()
  if (cmd) {
    ora('Completed ! Then it will run your cmd! ').succeed()
    const { stdout } = execa('npm', ['run', cmd], {
      cwd: process.cwd()
    })
    if (stdout) stdout.pipe(process.stdout)
  }
}

app()
