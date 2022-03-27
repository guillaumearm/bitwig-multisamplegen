import { query } from '.'
import inquirer from 'inquirer'

jest.mock('inquirer')

type Inquirer = typeof inquirer.prompt

describe('test cli running', () => {
  test('should pass test running ', async () => {
    ;(inquirer as any).prompt = jest.fn().mockResolvedValue({ cmd: 'start' })
    const info = await query()
    expect(info.cmd).toBe('start')
  })
})
