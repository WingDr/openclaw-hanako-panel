import readline from 'node:readline'

export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin
  const stdout = process.stdout

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Interactive password prompt requires a TTY')
  }

  readline.emitKeypressEvents(stdin)
  const previousRawMode = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()
  stdout.write(question)

  return await new Promise<string>((resolve, reject) => {
    let value = ''

    const cleanup = () => {
      stdin.off('keypress', onKeypress)
      stdin.setRawMode(Boolean(previousRawMode))
      stdin.pause()
    }

    const finish = (result: string) => {
      cleanup()
      stdout.write('\n')
      resolve(result)
    }

    const fail = (error: Error) => {
      cleanup()
      stdout.write('\n')
      reject(error)
    }

    const onKeypress = (text: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        fail(new Error('Prompt cancelled'))
        return
      }

      if (key.name === 'return' || key.name === 'enter') {
        finish(value)
        return
      }

      if (key.name === 'backspace') {
        value = value.slice(0, -1)
        return
      }

      if (text) {
        value += text
      }
    }

    stdin.on('keypress', onKeypress)
  })
}
