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

const AUTHOR_NAME = 'Trapcodien'

const MULTISAMPLE_FILE = 'multisample.xml'
const DEFAULT_VELOCITY = 127
const ALLOWED_EXTENSIONS = ['wav', 'aif', 'mp3', 'ogg']
const DEFAULT_COMPRESSION_TYPE = 'DEFLATE'

const DEFAULT_SELECTION_VALUE = DEFAULT_VELOCITY

type ValueMode = 'Velocity' | 'Selection'

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
  selection?: number
  postfix: string
  extension: string
  initialNumber: string
}

type FileNamesByNoteNumber = Record<number, ParsedFileName[]>

type Sample = {
  name: string
  key: number
  lowKey: number
  highKey: number
  velocityMin: number
  velocityMax: number
  initialNumber: string
  selectionMin: number
  selectionMax: number
}

const getVelocity = (parsed: ParsedFileName): number => {
  if (parsed.velocity === undefined) {
    return DEFAULT_VELOCITY
  }

  return parsed.velocity
}

const getSelection = (parsed: ParsedFileName): number => {
  if (parsed.selection === undefined) {
    return DEFAULT_SELECTION_VALUE
  }

  return parsed.selection
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
  filenames: ParsedFileName[],
  valueMode: ValueMode
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

  if (valueMode === 'Velocity') {
    // sort by velocity
    Object.keys(result).forEach((k) => {
      const n = Number(k)
      result[n] = sortBy((x) => getVelocity(x), result[n])
    })
  } else if (valueMode === 'Selection') {
    // sort by selection
    Object.keys(result).forEach((k) => {
      const n = Number(k)
      result[n] = sortBy((x) => getSelection(x), result[n])
    })
  }

  return result
}

const getSampleFromParsed = (
  allParsed: ParsedFileName[],
  valueMode: ValueMode
): Sample[] => {
  let selectionMin = 0
  let velocityMin = 0

  const grouped: Record<string, ParsedFileName[]> = groupBy(
    (filename) =>
      `${filename.note.toLowerCase()}${filename.octave}-${
        filename.initialNumber
      }`,
    allParsed
  )

  const groupedKeys = Object.keys(grouped)

  const maxIndex = groupedKeys.length - 1

  return groupedKeys.reduce((acc: Sample[], k, index) => {
    const parsedFileNames = grouped[k]

    if (!parsedFileNames.length) {
      return acc
    }

    const firstParsed = parsedFileNames[0]

    const velocityMax = getVelocity(firstParsed)
    const selectionMax = getSelection(firstParsed)

    let overrideVelocityMax = false
    let overrideSelectionMax = false

    // if last element
    if (valueMode === 'Velocity' && index === maxIndex) {
      overrideVelocityMax = true
    } else if (valueMode === 'Selection' && index === maxIndex) {
      overrideSelectionMax = true
    }

    const samples = parsedFileNames.map((parsed) => {
      const key = getNoteNumber(parsed)
      const sample = {
        name: parsed.fullname,
        key,
        lowKey: key,
        highKey: key,
        velocityMin: valueMode === 'Velocity' ? velocityMin : 0,
        velocityMax: valueMode === 'Velocity' ? velocityMax : 127,
        selectionMin: valueMode === 'Selection' ? selectionMin : 0,
        selectionMax: valueMode === 'Selection' ? selectionMax : 127,
        initialNumber: parsed.initialNumber
      }

      if (overrideSelectionMax) {
        sample.selectionMax = 127
      }

      if (overrideVelocityMax) {
        sample.velocityMax = 127
      }

      return sample
    })

    if (valueMode === 'Velocity') {
      velocityMin = velocityMax + 1
    } else if (valueMode === 'Selection') {
      selectionMin = selectionMax + 1
    }

    return [...acc, ...samples]
  }, [] as Sample[])
}

const parseFileName = (
  filename: string,
  valueMode: ValueMode
): ParsedFileName | null => {
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
    velocity: valueMode === 'Velocity' ? Number(res[4]) : 127,
    selection: valueMode === 'Selection' ? Number(res[4]) : 127,
    postfix: res[5],
    extension: res[6],
    initialNumber: res[4] || ''
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

const getAllSamples = (filenames: string[], valueMode: ValueMode): Sample[] => {
  const parsedFilenames = filenames
    .map((filename) => parseFileName(filename, valueMode))
    .filter((parsed): parsed is ParsedFileName => !!parsed)

  const filenamesByNote = getFileNamesByNoteNumber(parsedFilenames, valueMode)

  let result: Sample[] = []

  Object.keys(filenamesByNote).forEach((k) => {
    const n = Number(k)
    result = [...result, ...getSampleFromParsed(filenamesByNote[n], valueMode)]
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

const generateSampleXml = (
  sample: Sample,
  keyfade: number,
  valueMode: ValueMode,
  valueFade: number,
  spreadSelectionsFadeValue: number | undefined
): string => {
  const selectionFade =
    spreadSelectionsFadeValue === undefined
      ? valueFade
      : spreadSelectionsFadeValue

  const keyLowFade =
    sample.lowKey > 0
      ? Math.min(keyfade, Math.abs(sample.key - sample.lowKey))
      : 0
  const keyHighFade =
    sample.highKey < 127
      ? Math.min(keyfade, Math.abs(sample.highKey - sample.key))
      : 0

  const maximumFadeVelocity = Math.trunc(
    Math.abs(sample.velocityMax - sample.velocityMin) / 2
  )

  const velocityLowFade =
    valueMode === 'Velocity' && sample.velocityMin > 0
      ? Math.min(valueFade, maximumFadeVelocity)
      : 0
  const velocityHighFade =
    valueMode === 'Velocity' && sample.velocityMax < 127
      ? Math.min(valueFade, maximumFadeVelocity)
      : 0

  const maximumFadeSelection = Math.trunc(
    Math.abs(sample.selectionMax - sample.selectionMin) / 2
  )

  const selectLowFade =
    valueMode === 'Selection' && sample.selectionMin > 0
      ? Math.min(selectionFade, maximumFadeSelection)
      : 0

  const selectHighFade =
    valueMode === 'Selection' && sample.selectionMax < 127
      ? Math.min(selectionFade, maximumFadeSelection)
      : 0

  const param1 = sample.key
  const param2 =
    valueMode === 'Velocity' ? sample.velocityMax : sample.selectionMax

  // TODO find an utility for this param (e.g. random using filename's prefix as a seed)
  const param3 = 0

  const zoneLogic = 'always-play' // or 'round-robin'

  return `
  <sample file="${sample.name}" gain="0.00" parameter-1="${param1}" parameter-2="${param2}" parameter-3="${param3}" reverse="false" sample-start="0.000" sample-stop="-1" zone-logic="${zoneLogic}">
    <key low-fade="${keyLowFade}" high-fade="${keyHighFade}" low="${sample.lowKey}" high="${sample.highKey}" root="${sample.key}" track="1.0000" tune="0.00"/>
    <velocity low-fade="${velocityLowFade}" high-fade="${velocityHighFade}" low="${sample.velocityMin}" high="${sample.velocityMax}" />
    <select low-fade="${selectLowFade}" high-fade="${selectHighFade}" low="${sample.selectionMin}" high="${sample.selectionMax}"/>
    <loop fade="0.0000" mode="off" start="0.000" />
  </sample>
`
}

const generateMultiSampleXml = (
  instrumentName: string,
  author: string,
  samples: Sample[],
  keyfade: number,
  valueMode: ValueMode,
  valueFade: number,
  spreadSelectionsFadeValue: number | undefined
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
    xmlResult =
      xmlResult +
      generateSampleXml(
        sample,
        keyfade,
        valueMode,
        valueFade,
        spreadSelectionsFadeValue
      )
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

const stretchNotes = (allSamples: Sample[], valueMode: ValueMode): Sample[] => {
  let result: Sample[] = []
  const groupedSamples =
    valueMode === 'Velocity'
      ? groupBy((x) => String(x.velocityMax), allSamples)
      : groupBy((x) => String(x.selectionMax), allSamples)

  Object.keys(groupedSamples).forEach((k) => {
    // sort sample by key
    groupedSamples[k] = sortBy((sample) => sample.key, groupedSamples[k])

    // compute highKey and lowKey
    const samples = groupedSamples[k]

    const nextSamples = groupedSamples[k].map((sample, index) => {
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
 * - apply velocity/selection fades
 */
const transformSamples = (
  givenSamples: Sample[],
  keyfade: number,
  valueMode: ValueMode,
  valueFade: number,
  spreadSelectionsFadeValue: number | undefined
): Sample[] => {
  const allSamples = stretchNotes(givenSamples, valueMode)
  const transformedSamples: Sample[] = allSamples
    .map((sample) => {
      return {
        ...sample,
        lowKey: Math.max(0, sample.lowKey - keyfade),
        highKey: Math.min(127, sample.highKey + keyfade)
      }
    })
    .map((sample) => {
      if (valueMode === 'Velocity') {
        return {
          ...sample,
          velocityMin: Math.max(0, sample.velocityMin - valueFade),
          velocityMax: Math.min(127, sample.velocityMax + valueFade)
        }
      } else if (valueMode === 'Selection') {
        return {
          ...sample,
          selectionMin: Math.max(0, sample.selectionMin - valueFade),
          selectionMax: Math.min(127, sample.selectionMax + valueFade)
        }
      }
      return sample
    })

  if (spreadSelectionsFadeValue !== undefined) {
    const resultSamples: Sample[] = []

    const grouped: Record<string, Sample[]> = groupBy(
      (s) => `${s.key}${s.initialNumber}`,
      transformedSamples
    )

    Object.keys(grouped).forEach((k) => {
      const group = grouped[k]
      if (group.length) {
        const ratio = 127 / group.length

        group.forEach((sample, index) => {
          const newSample: Sample = {
            ...sample,
            selectionMin: Math.ceil(
              Math.max(
                0,
                Math.min(127, index * ratio - spreadSelectionsFadeValue)
              )
            ),
            selectionMax: Math.floor(
              Math.max(
                0,
                Math.min(127, (index + 1) * ratio + spreadSelectionsFadeValue)
              )
            )
          }

          resultSamples.push(newSample)
        })
      }
    })

    return resultSamples
  }

  return transformedSamples
}

const generateZipFile = async (
  pathdir: string,
  samples: Sample[],
  givenPackageName: string,
  keyfade: number,
  compression: 'DEFLATE' | undefined,
  valueMode: ValueMode,
  valueFade: number,
  spreadSelectionsFadeValue: number | undefined
) => {
  const packageName = `${givenPackageName}.multisample`

  if (await isFileExist(packageName)) {
    ora(`File '${packageName}' already exist!`).fail()
    return
  }

  const zip = new JSZip()

  zip.file(
    MULTISAMPLE_FILE,
    generateMultiSampleXml(
      givenPackageName,
      AUTHOR_NAME,
      samples,
      keyfade,
      valueMode,
      valueFade,
      spreadSelectionsFadeValue
    ),
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

const getNbDuplicateNotes = (samples: Sample[]): number => {
  let counter = 0

  const grouped: Record<string, Sample[]> = groupBy(
    (s) => `${s.key}${s.initialNumber}`,
    samples
  )

  Object.keys(grouped).forEach((k) => {
    if (grouped[k].length > 1) {
      counter += grouped[k].length
    }
  })

  return counter
}

const app = async () => {
  const pathdir = args._[0]
  if (pathdir) {
    const fileNames = await readFileNames(pathdir)

    if (!fileNames) {
      return
    }

    const valueModePayload = await inquirer.prompt([
      {
        type: 'list',
        name: 'valueMode',
        message: 'Choose the desired value mode',
        default: 'Velocity' as ValueMode,
        choices: ['Velocity', 'Selection'] as ValueMode[]
      }
    ])

    const valueMode: ValueMode = valueModePayload.valueMode

    const samples = getAllSamples(fileNames, valueMode)

    if (samples.length === 0) {
      ora(`Warning: no valid sample files found in directory`).fail()
      return
    }

    const nbDuplicateNotes = getNbDuplicateNotes(samples)

    const inquirerQuestions: ReadonlyArray<inquirer.DistinctQuestion<
      any
    > | null> = [
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
        type: 'input',
        name: 'valueFade',
        message: `${valueMode} fade value`,
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
      valueMode === 'Velocity' && nbDuplicateNotes > 0
        ? {
            type: 'confirm',
            name: 'spreadSelection',
            message: `${nbDuplicateNotes} duplicate notes found, Would you want to spread samples selection ?`,
            default: false
          }
        : null
    ]

    const info = await inquirer.prompt(
      inquirerQuestions.filter((x) => Boolean(x))
    )

    const inquirerQuestions2: ReadonlyArray<inquirer.DistinctQuestion<
      any
    > | null> = [
      info.spreadSelection === true
        ? {
            type: 'input',
            name: 'spreadSelectionFade',
            message: 'spread selections fade value',
            default: 0,
            validate(value) {
              const valid = !isNaN(parseFloat(value))
              return valid || 'Please enter a number'
            },
            filter: (value) => {
              const valid = !isNaN(parseFloat(value))
              return valid ? Math.abs(Number(value)) : ''
            }
          }
        : null,
      {
        type: 'confirm',
        name: 'compression',
        message: 'Enable compression ?',
        default: true
      }
    ]

    const info2 = await inquirer.prompt(
      inquirerQuestions2.filter((x) => Boolean(x))
    )

    const spreadSelectionsFadeValue: number | undefined =
      info2.spreadSelectionFade

    const compression = info2.compression ? DEFAULT_COMPRESSION_TYPE : undefined

    await generateZipFile(
      pathdir,
      transformSamples(
        samples,
        info.keyfade,
        valueMode,
        info.valueFade,
        spreadSelectionsFadeValue
      ),
      info.packageName,
      info.keyfade,
      compression,
      valueMode,
      info.valueFade,
      spreadSelectionsFadeValue
    )
  } else {
    ora(`Usage: ${args.$0} <pathdir>`).warn()
  }
}

app()
