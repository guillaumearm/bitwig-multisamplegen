#!/usr/bin/env node

import ora from 'ora'
import yargs from 'yargs'
import fs from 'fs'
import path from 'path'
import { groupBy, sortBy } from 'ramda'
import inquirer from 'inquirer'

import JSZip from 'jszip'

const args = yargs.argv

const checkValidDirectory = async (
  pathdir: string
): Promise<false | string> => {
  try {
    const res = await fs.promises.stat(pathdir)

    if (res) {
      return false
    } else {
      return `Error: '${pathdir}' is not a directory`
    }
  } catch (e) {
    return `${e}`
  }
}

const isFileExist = async (givenPath: string): Promise<boolean> => {
  try {
    const res = await fs.promises.stat(givenPath)
    if (res) {
      return true
    }
  } catch (e) {}
  return false
}

// TODO inquirer prompt
const AUTHOR_NAME = 'Trapcodien'

const MULTISAMPLE_FILE = 'multisample.xml'
const DEFAULT_VELOCITY = 127
const ALLOWED_EXTENSIONS = ['wav', 'aif', 'mp3', 'ogg']
const DEFAULT_COMPRESSION_TYPE = 'DEFLATE'

const ALL_NOTES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B'
]

type ParsedFileName = {
  fullname: string
  prefix: string
  note: string
  octave: number
  velocity?: number
  postfix: string
  extension: string
}

type FileNamesByNoteNumber = Record<number, ParsedFileName[]>

type Sample = {
  name: string
  key: number
  lowKey: number
  highKey: number
  velocityMin: number
  velocityMax: number
}

const getVelocity = (parsed: ParsedFileName): number => {
  if (parsed.velocity === undefined) {
    return DEFAULT_VELOCITY
  }

  return parsed.velocity
}

const getNoteNumber = (parsed: ParsedFileName): number => {
  const note = parsed.note.toUpperCase()
  const noteIndex = ALL_NOTES.findIndex((n) => n === note)

  if (noteIndex === -1) {
    throw new Error(`Unknown note: '${note}'`)
  }

  const noteNumber = INITIAL_MIDI_OCTAVE * 12 + parsed.octave * 12 + noteIndex

  if (noteNumber < 0 || noteNumber > 127) {
    throw new Error('Invalid noteNumber out of range')
  }

  return noteNumber
}

const getFileNamesByNoteNumber = (
  filenames: ParsedFileName[]
): FileNamesByNoteNumber => {
  const result: FileNamesByNoteNumber = {}

  // provide data to result
  filenames.forEach((parsed) => {
    const n = getNoteNumber(parsed)
    if (!result[n]) {
      result[n] = []
    }
    result[n].push(parsed)
  })

  // sort by velocity
  Object.keys(result).forEach((k) => {
    const n = Number(k)
    result[n] = sortBy((x) => getVelocity(x), result[n])
  })

  return result
}

const getSampleFromParsed = (parsed: ParsedFileName[]): Sample[] => {
  let velocityMin = 0

  return parsed.reduce((acc: Sample[], parsed) => {
    const velocityMax = getVelocity(parsed)
    const key = getNoteNumber(parsed)

    const sample = {
      name: parsed.fullname,
      key,
      lowKey: key,
      highKey: key,
      velocityMin,
      velocityMax
    }
    velocityMin = velocityMax + 1

    return [...acc, sample]
  }, [] as Sample[])
}

const parseFileName = (filename: string): ParsedFileName | null => {
  const res = filename.match(
    /^(.*)([abcdefgABCDEFG]#?)([0-9])-?(\d{1,3})?(.*)\.(.*)/
  )

  if (res === null) {
    return null
  }

  const parsed: ParsedFileName = {
    fullname: res[0],
    prefix: res[1],
    note: res[2],
    octave: Number(res[3]),
    velocity: Number(res[4]),
    postfix: res[5],
    extension: res[6]
  }

  if (!ALLOWED_EXTENSIONS.includes(parsed.extension.toLowerCase())) {
    ora(`ignored '${parsed.fullname}' file`).warn()
    return null
  }

  if (isNaN(parsed.octave)) {
    ora(`unable to parse octave: '${res[3]}'`).fail()
    return null
  }

  if (isNaN(getVelocity(parsed))) {
    ora(`unable to parse velocity: '${res[4]}'`).fail()
    return null
  }

  if (parsed.velocity && (parsed.velocity < 0 || parsed.velocity > 127)) {
    ora(`invalid velocity range : '${parsed.velocity}'`).fail()
    return null
  }
  return parsed
}

const getAllSamples = (filenames: string[]): Sample[] => {
  const parsedFilenames = filenames
    .map(parseFileName)
    .filter((parsed): parsed is ParsedFileName => !!parsed)

  const filenamesByNote = getFileNamesByNoteNumber(parsedFilenames)

  let result: Sample[] = []

  Object.keys(filenamesByNote).forEach((k) => {
    const n = Number(k)
    result = [...result, ...getSampleFromParsed(filenamesByNote[n])]
  })

  return result
}

// i.e. C0 will be considered as C1
const INITIAL_MIDI_OCTAVE = 1

const readFileNames = async (
  givenPathdir: string
): Promise<string[] | false> => {
  const pathdir = path.resolve(givenPathdir)

  const spinner = ora(`Read '${pathdir}' directory`).start()

  const err = await checkValidDirectory(pathdir)

  if (err) {
    spinner.text = err
    spinner.fail()
    return false
  }

  const res = await fs.promises.readdir(pathdir)

  spinner.text = `Readed '${pathdir}' directory`
  spinner.succeed()

  return res
}

const generateSampleXml = (sample: Sample, keyfade: number): string => {
  const keyLowFade =
    sample.lowKey > 0 ? Math.min(keyfade, sample.key - sample.lowKey) : 0
  const keyHighFade =
    sample.highKey < 127 ? Math.min(keyfade, sample.highKey - sample.key) : 0

  return `
  <sample file="${sample.name}" gain="0.00" parameter-1="0.0000" parameter-2="0.0000" parameter-3="0.0000" reverse="false" sample-start="0.000" sample-stop="-1" zone-logic="always-play">
    <key low-fade="${keyLowFade}" high-fade="${keyHighFade}" low="${sample.lowKey}" high="${sample.highKey}" root="${sample.key}" track="1.0000" tune="0.00"/>
    <velocity low="${sample.velocityMin}" high="${sample.velocityMax}" />
    <select low="0" high="127"/>
    <loop fade="0.0000" mode="off" start="0.000" />
  </sample>
`
}

const generateMultiSampleXml = (
  instrumentName: string,
  author: string,
  samples: Sample[],
  keyfade: number
): string => {
  let xmlResult = `<?xml version="1.0" encoding="UTF-8"?>
<multisample name="${instrumentName}">
  <generator>Bitwig Studio</generator>
  <category></category>
  <creator>${author}</creator>
  <description></description>
  <keywords></keywords>
  `

  samples.forEach((sample) => {
    xmlResult = xmlResult + generateSampleXml(sample, keyfade)
  })

  xmlResult = xmlResult + '</multisample>'
  return xmlResult
}

// const generateMultiSampleXmlFile = async (
//   pathdir: string,
//   samples: Sample[]
// ): Promise<boolean> => {
//   const multiSampleXmlPath = path.join(pathdir, MULTISAMPLE_FILE)

//   if (await isFileExist(multiSampleXmlPath)) {
//     ora(`${MULTISAMPLE_FILE} file already exist!`).fail()
//     return false
//   }

//   const spinner = ora(`Generate ${MULTISAMPLE_FILE} file`).start()

//   const xml = generateMultiSampleXml(samples)
//   await fs.promises.writeFile(multiSampleXmlPath, xml)

//   spinner.text = `Generated ${MULTISAMPLE_FILE} file`
//   spinner.succeed()
//   return true
// }

const computeLowKey = (
  samples: Sample[],
  sample: Sample,
  index: number
): Sample => {
  if (index === 0) {
    return {
      ...sample,
      lowKey: 0
    }
  }

  const previousSample = samples[index - 1]

  const value = Math.trunc((sample.key - previousSample.key) / 2)
  const lowKey = Math.max(0, sample.key - value + 1)

  return {
    ...sample,
    lowKey
  }
}

const computeHighKey = (
  samples: Sample[],
  sample: Sample,
  index: number
): Sample => {
  if (index >= samples.length - 1) {
    return {
      ...sample,
      highKey: 127
    }
  }

  const nextSample = samples[index + 1]

  const value = Math.trunc((nextSample.key - sample.key + 1) / 2)
  const highKey = Math.min(127, sample.key + value)

  return {
    ...sample,
    highKey
  }
}

const stretchNotes = (allSamples: Sample[]): Sample[] => {
  let result: Sample[] = []
  const groupedSamples = groupBy((x) => String(x.velocityMax), allSamples)

  Object.keys(groupedSamples).forEach((velocity) => {
    // sort sample by key
    groupedSamples[velocity] = sortBy(
      (sample) => sample.key,
      groupedSamples[velocity]
    )

    // compute highKey and lowKey
    const samples = groupedSamples[velocity]

    const nextSamples = groupedSamples[velocity].map((sample, index) => {
      const computedSample = computeLowKey(samples, sample, index)
      return computeHighKey(samples, computedSample, index)
    })
    result = [...result, ...nextSamples]
  })

  return result
}

/**
 * - stretch notes
 * - apply key fades
 * - TODO: apply velocity fades
 */
const transformSamples = (
  givenSamples: Sample[],
  keyfade: number
): Sample[] => {
  const allSamples = stretchNotes(givenSamples)
  return allSamples.map((sample) => {
    return {
      ...sample,
      lowKey: Math.max(0, sample.lowKey - keyfade),
      highKey: Math.min(127, sample.highKey + keyfade)
    }
  })
}

const generateZipFile = async (
  pathdir: string,
  samples: Sample[],
  givenPackageName: string,
  keyfade: number,
  compression: 'DEFLATE' | undefined
) => {
  const packageName = `${givenPackageName}.multisample`

  if (await isFileExist(packageName)) {
    ora(`File '${packageName}' already exist!`).fail()
    return
  }

  const zip = new JSZip()

  zip.file(
    MULTISAMPLE_FILE,
    generateMultiSampleXml(givenPackageName, AUTHOR_NAME, samples, keyfade),
    { compression }
  )

  const spinner = ora('Copy sample files...').start()

  for (const sample of samples) {
    const filename = path.join(pathdir, sample.name)

    spinner.text = `Reading '${filename}' sample file...`

    const buffer = await fs.promises.readFile(filename)
    zip.file(sample.name, buffer, { compression })
  }

  spinner.text = `Creating '${packageName}' multisample package file...`

  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  await fs.promises.writeFile(path.join(pathdir, packageName), buffer, 'binary')

  spinner.text = `Successfully created '${packageName}' multisample package file!`
  spinner.succeed()
}

const app = async () => {
  const pathdir = args._[0]
  if (pathdir) {
    const fileNames = await readFileNames(pathdir)

    if (!fileNames) {
      return
    }

    const samples = getAllSamples(fileNames)

    if (samples.length === 0) {
      ora(`Warning: no valid sample files found in directory`).fail()
      return
    }

    const info = await inquirer.prompt([
      {
        type: 'input',
        name: 'packageName',
        message: 'Multisample Package name',
        validate: (input: string) => {
          return input && input.length > 0
        },
        default: ''
      },
      {
        type: 'input',
        name: 'keyfade',
        message: 'Pitch fade value',
        default: 0,
        validate(value) {
          const valid = !isNaN(parseFloat(value))
          return valid || 'Please enter a number'
        },
        filter: (value) => {
          const valid = !isNaN(parseFloat(value))
          return valid ? Math.abs(Number(value)) : ''
        }
      },
      {
        type: 'confirm',
        name: 'compression',
        message: 'Enable compression ?',
        default: true
      }
    ])

    const compression = info.compression ? DEFAULT_COMPRESSION_TYPE : undefined

    await generateZipFile(
      pathdir,
      transformSamples(samples, info.keyfade),
      info.packageName,
      info.keyfade,
      compression
    )
  } else {
    ora(`Usage: ${args.$0} <pathdir>`).warn()
  }
}

app()
