// @flow
'use babel'

import {CompositeDisposable} from 'atom'
import {filter} from 'fuzzaldrin-plus'
import _ from 'lodash'
import os from 'os'
import {isValidEditor} from '../utils'
import {allPackages, isVendorSupported} from '../go'
import {wantedPackage, getPackage, addImport} from './gocodeprovider-helper'

import type {GoConfig} from '../config/service'
import type {AutocompleteProvider, Suggestion, SuggestionType, SuggestionRequest} from './provider'
import type {ExecutorOptions} from '../config/executor'

type FuzzySuggestion = {
  ...Suggestion,
  fuzzyMatch?: string
}

type Snippet = {
  snippet: string,
  displayText: string
}

type GoParam = {
  isFunc: bool,
  name: string,
  identifier: string,
  type: GoType | string // eslint-disable-line no-use-before-define
}

type GoType = {
  isFunc: bool,
  name: string,
  args?: Array<GoParam>,
  returns?: Array<GoParam>
}

type GoCodeSuggestion = {
  class: 'func' | 'package' | 'var' | 'type' | 'const' | 'PANIC',
  name: string,
  type: string
}

type RawGoCodeSuggestion = [number, GoCodeSuggestion[]]
type EmptyRawGoCodeSuggestion = [] | RawGoCodeSuggestion

class GocodeProvider implements AutocompleteProvider {
  goconfig: GoConfig
  subscriptions: CompositeDisposable
  subscribers: Array<(Promise<any>) => void>
  currentSuggestions: Array<Suggestion>
  proposeBuiltins: bool
  unimportedPackages: bool
  selector: string
  inclusionPriority: number
  panicked: bool
  excludeLowerPriority: bool
  suppressForCharacters: Array<string>
  snippetMode: 'name' | 'nameAndType' | 'none'
  shouldSuppressStringQuoted: bool
  disableForSelector: string
  allPkgs: Map<string, string[]>

  constructor (goconfig: GoConfig) {
    this.goconfig = goconfig
    this.subscriptions = new CompositeDisposable()
    this.subscribers = []
    this.currentSuggestions = []

    this.proposeBuiltins = true
    this.unimportedPackages = true
    this.selector = '.source.go'
    this.inclusionPriority = 1
    this.excludeLowerPriority = atom.config.get('go-plus.autocomplete.suppressBuiltinAutocompleteProvider')
    this.suppressForCharacters = []
    this.filterSelectors()
    const suppressSubscription = atom.config.observe('go-plus.autocomplete.suppressActivationForCharacters', (value) => {
      this.suppressForCharacters = _.map(value, (c) => {
        let char = c ? c.trim() : ''
        char = (() => {
          switch (false) {
            case char.toLowerCase() !== 'comma':
              return ','
            case char.toLowerCase() !== 'newline':
              return '\n'
            case char.toLowerCase() !== 'space':
              return ' '
            case char.toLowerCase() !== 'tab':
              return '\t'
            default:
              return char
          }
        })()
        return char
      })
      this.suppressForCharacters = _.compact(this.suppressForCharacters)
    })
    this.subscriptions.add(suppressSubscription)
    const snippetModeSubscription = atom.config.observe('go-plus.autocomplete.snippetMode', (value) => {
      this.snippetMode = value
    })
    this.subscriptions.add(snippetModeSubscription)
    this.subscriptions.add(atom.config.observe('go-plus.autocomplete.proposeBuiltins', (value) => {
      this.proposeBuiltins = value
      this.toggleGocodeConfig()
    }))
    this.subscriptions.add(atom.config.observe('go-plus.autocomplete.unimportedPackages', (value) => {
      this.unimportedPackages = value
      this.toggleGocodeConfig()
    }))

    this.allPkgs = allPackages(this.goconfig)
  }

  dispose () {
    if (this.subscriptions) {
      this.subscriptions.dispose()
    }
    this.subscriptions = null
    this.subscribers = []
    this.currentSuggestions = []
  }

  toggleGocodeConfig () {
    if (this.goconfig) {
      this.goconfig.locator.findTool('gocode').then((cmd) => {
        if (!cmd) {
          return
        }
        const gocode = cmd
        const opt = this.goconfig.executor.getOptions('file')
        this.goconfig.executor.exec(gocode, ['set', 'unimported-packages', this.unimportedPackages.toString()], opt).then((r) => {
          const stderr = r.stderr instanceof Buffer ? r.stderr.toString() : r.stderr
          if (stderr && stderr.trim() !== '') {
            console.log('autocomplete-go: (stderr) ' + stderr)
          }
        }).then(() => {
          if (!this.goconfig) {
            return
          }
          return this.goconfig.executor.exec(gocode, ['set', 'propose-builtins', this.proposeBuiltins.toString()], opt).then((r) => {
            const stderr = r.stderr instanceof Buffer ? r.stderr.toString() : r.stderr
            if (stderr && stderr.trim() !== '') {
              console.log('autocomplete-go: (stderr) ' + stderr)
            }
          })
        })
      }).catch((e) => {
        console.log(e)
      })
    }
  }

  filterSelectors () {
    const configSelectors = atom.config.get('go-plus.autocomplete.scopeBlacklist')
    this.shouldSuppressStringQuoted = false
    const selectors = []
    if (configSelectors && configSelectors.length) {
      for (let selector of configSelectors.split(',')) {
        selector = selector.trim()
        if (selector.includes('.string.quoted')) {
          this.shouldSuppressStringQuoted = true
        } else {
          selectors.push(selector)
        }
      }
    }
    this.disableForSelector = selectors.join(', ')
  }

  ready () {
    return !!this.goconfig
  }

  characterIsSuppressed (char: string, scopeDescriptor: {scopes: Array<string>}): bool {
    if (scopeDescriptor && scopeDescriptor.scopes && scopeDescriptor.scopes.length > 0) {
      for (const scope of scopeDescriptor.scopes) {
        if (scope === 'entity.name.import.go') {
          return false
        }

        if (this.shouldSuppressStringQuoted && scope && scope.startsWith('string.quoted')) {
          return scopeDescriptor.scopes.indexOf('entity.name.import.go') === -1
        }
      }
    }
    return this.suppressForCharacters.indexOf(char) !== -1
  }

  getSuggestions (options: SuggestionRequest): Promise<Array<Suggestion>> {
    // only invoke gocode when a new word starts or the '.' char is entered
    // on all other keystrokes we just fuzzy filter the previous set of suggestions
    let {prefix} = options
    prefix = prefix.trim()
    if (prefix === '') {
      if (!options.activatedManually) {
        this.currentSuggestions = []
        const p = Promise.resolve([])
        this.notifySubscribers(p)
        return p
      }
    }
    if (prefix.length > 0 && prefix !== '.' && this.currentSuggestions.length) {
      // fuzzy filter on this.currentSuggestions
      const p = new Promise((resolve) => {
        resolve(filter(this.currentSuggestions, prefix, {key: 'fuzzyMatch'})
          .map(s => Object.assign({}, s, {replacementPrefix: prefix})))
      })
      this.notifySubscribers(p)
      return p
    }

    // get a fresh set of suggestions from gocode
    const p: Promise<Array<Suggestion>> = new Promise((resolve) => {
      const { editor, bufferPosition } = options
      if (!options || !this.ready() || !isValidEditor(editor)) {
        resolve([])
        return
      }

      const buffer = editor.getBuffer()
      if (!buffer || !bufferPosition) {
        resolve([])
        return
      }

      const index = buffer.characterIndexForPosition(bufferPosition)
      const priorBufferPosition = bufferPosition.copy()
      if (priorBufferPosition.column > 0) {
        priorBufferPosition.column = priorBufferPosition.column - 1
      }
      const scopeDescriptor = editor.scopeDescriptorForBufferPosition(priorBufferPosition)
      const text = editor.getText()
      if (!options.activatedManually && index > 0 && this.characterIsSuppressed(text[index - 1], scopeDescriptor)) {
        resolve([])
        return
      }
      const offset = Buffer.byteLength(text.substring(0, index), 'utf8')

      this.goconfig.locator.findTool('gocode').then((cmd) => {
        if (!cmd) {
          resolve([])
          return
        }
        const file = buffer.getPath()
        const args = ['-f=json', 'autocomplete', file, offset.toString()]
        const execOptions = this.goconfig.executor.getOptions('file', editor)
        execOptions.input = text

        this.executeGocode(cmd, args, execOptions)
          .then((rawSuggestions: EmptyRawGoCodeSuggestion): EmptyRawGoCodeSuggestion | Promise<EmptyRawGoCodeSuggestion> => {
            if (rawSuggestions.length === 0 && prefix === '.') {
              return isVendorSupported(this.goconfig).then((useVendor: boolean): EmptyRawGoCodeSuggestion | Promise<EmptyRawGoCodeSuggestion> => {
                const pkg = wantedPackage(buffer, bufferPosition)
                if (!pkg) {
                  return []
                }
                const pkgs = this.allPkgs.get(pkg)
                if (!pkgs || !pkgs.length) {
                  return []
                }
                const {GOPATH} = this.goconfig.environment()
                const pkgPath = getPackage(file, GOPATH, pkgs, useVendor)
                if (!pkgPath) {
                  return []
                }
                const added = addImport(buffer, pkgPath, offset)
                if (!added) {
                  return []
                }
                const args = ['-f=json', 'autocomplete', file, added.offset.toString()]
                const execOptions = this.goconfig.executor.getOptions('file', editor)
                execOptions.input = added.text
                if (cmd) {
                  return this.executeGocode(cmd, args, execOptions)
                }
                return []
              })
            }
            return rawSuggestions
          })
          .then((rawSuggestions: EmptyRawGoCodeSuggestion) => {
            let suggestions: Suggestion[] = []
            if (rawSuggestions.length > 0) {
              suggestions = this.mapMessages((rawSuggestions: any), editor, bufferPosition)
            }
            this.currentSuggestions = suggestions
            resolve(suggestions)
          })
      })
    })

    this.notifySubscribers(p)
    return p
  }

  executeGocode (cmd: string, args: string[], options: ExecutorOptions): Promise<EmptyRawGoCodeSuggestion> {
    return this.goconfig.executor.exec(cmd, args, options).then((r) => {
      const stderr = r.stderr instanceof Buffer ? r.stderr.toString() : r.stderr
      if (stderr && stderr.trim() !== '') {
        console.log('go-plus: Failed to run gocode:', r.stderr)
      }
      const data = r.stdout instanceof Buffer ? r.stdout.toString() : r.stdout
      if (!data || !data.trim()) {
        return []
      }
      try {
        return JSON.parse(data)
      } catch (e) {
        if (e && e.handle) {
          e.handle()
        }
        atom.notifications.addError('gocode error', {
          detail: r.stdout,
          dismissable: true
        })
        console.log('go-plus: Failed to parse the output of gocode:', e)
        return []
      }
    }).catch((e) => {
      console.log(e)
      return []
    })
  }

  notifySubscribers (p: Promise<Array<Suggestion>>) {
    if (this.subscribers && this.subscribers.length > 0) {
      for (const subscriber of this.subscribers) {
        subscriber(p)
      }
    }
  }

  onDidGetSuggestions (s: (Promise<any>) => void) {
    if (this.subscribers) {
      this.subscribers.push(s)
    }
  }

  mapMessages (res: RawGoCodeSuggestion, editor: any, position: any): Array<Suggestion> {
    const candidates: GoCodeSuggestion[] = res[1]
    if (!candidates || !candidates.length) {
      return []
    }
    if (candidates[0] && candidates[0].class === 'PANIC' && candidates[0].type === 'PANIC' && candidates[0].name === 'PANIC') {
      this.bounceGocode()
    }
    const numPrefix: number = res[0]
    const prefix = editor.getTextInBufferRange([[position.row, position.column - numPrefix], position])
    let suffix = false
    try {
      suffix = editor.getTextInBufferRange([position, [position.row, position.column + 1]])
    } catch (e) {
      console.log(e)
    }
    const suggestions = []
    for (const c of candidates) {
      let suggestion: FuzzySuggestion = {
        replacementPrefix: prefix,
        leftLabel: c.type || c.class,
        type: this.translateType(c.class)
      }
      if (c.class === 'func' && (!suffix || suffix !== '(')) {
        suggestion = this.upgradeSuggestion(suggestion, c)
      } else {
        suggestion.text = c.name
        suggestion.fuzzyMatch = suggestion.text
      }
      if (suggestion.type === 'package') {
        suggestion.iconHTML = '<i class="icon-package"></i>'
      }
      suggestions.push(suggestion)
    }
    return suggestions
  }

  translateType (type: string): SuggestionType {
    switch (type) {
      case 'func':
        return 'function'
      case 'package':
        return 'import'
      case 'var':
        return 'variable'
      case 'type':
        return 'type'
      case 'const':
        return 'constant'
      default:
        return 'value'
    }
  }

  matchFunc (type: string): [?string, ?string, ?string] {
    if (!type || !type.startsWith('func(')) {
      return [undefined, undefined, undefined]
    }

    let count = 0
    let args
    let returns
    let returnsStart = 0
    for (let i = 0; i < type.length; i++) {
      if (type[i] === '(') {
        count = count + 1
      }

      if (type[i] === ')') {
        count = count - 1
        if (count === 0) {
          args = type.substring('func('.length, i)
          returnsStart = i + ') '.length
          break
        }
      }
    }

    if (type.length > returnsStart) {
      if (type[returnsStart] === '(') {
        returns = type.substring(returnsStart + 1, type.length - 1)
      } else {
        returns = type.substring(returnsStart, type.length)
      }
    }

    return [type, args, returns]
  }

  parseType (type: string): GoType {
    const result: GoType = {
      isFunc: false,
      name: '',
      args: [],
      returns: []
    }
    if (!type || type.trim() === '') {
      return result
    }
    const match = this.matchFunc(type)
    if (!match[0]) {
      return {
        ...result,
        name: type
      }
    }

    const args = match[1]
    const returns = match[2]
    if (!args && !returns) {
      return {
        ...result,
        isFunc: true,
        name: type
      }
    }

    return {
      isFunc: true,
      name: type,
      args: args ? this.parseParameters(args) : [],
      returns: returns ? this.parseParameters(returns) : []
    }
  }

  ensureNextArg (args: Array<string>): Array<string> {
    if (!args || args.length === 0) {
      return []
    }

    let arg = args[0]
    let hasFunc = false
    if (arg.includes('func(')) {
      hasFunc = true
    }
    if (!hasFunc) {
      return args
    }
    let start = 4
    if (!arg.startsWith('func(')) {
      let splitArg = arg.split(' ')
      if (!splitArg || splitArg.length < 2 || !splitArg[1].startsWith('func(')) {
        return args
      }
      start = splitArg[0].length + 5
    }

    const funcArg = args.join(', ')
    let end = 0
    let count = 0
    for (let i = start; i < funcArg.length; i++) {
      if (funcArg[i] === '(') {
        count = count + 1
      } else if (funcArg[i] === ')') {
        count = count - 1
        if (count === 0) {
          end = i + 1
          break
        }
      }
    }

    arg = funcArg.substring(0, end)
    if (arg.length === funcArg.length || !funcArg.substring(end + 2, funcArg.length).includes(', ')) {
      return [funcArg.trim()]
    }

    if (funcArg[end + 1] === '(') {
      for (let i = end + 1; i < funcArg.length; i++) {
        if (funcArg[i] === '(') {
          count = count + 1
        } else if (funcArg[i] === ')') {
          count = count - 1
          if (count === 0) {
            end = i + 1
            break
          }
        }
      }
    }

    arg = funcArg.substring(0, end)
    if (arg.length === funcArg.length || !funcArg.substring(end + 2, funcArg.length).includes(', ')) {
      return [funcArg.trim()]
    }

    for (let i = end; i < funcArg.length; i++) {
      if (funcArg[i] === ',') {
        arg = arg + funcArg.substring(end, i)
        end = i + 1
        break
      }
    }

    args = funcArg.substring(end + 1, funcArg.length).trim().split(', ')
    args.unshift(arg.trim())
    return args
  }

  parseParameters (p: string): Array<GoParam> {
    if (!p || p.trim() === '') {
      return []
    }
    let args: Array<string> = p.split(/, /)
    const result: Array<GoParam> = []
    let more = true
    while (more) {
      args = this.ensureNextArg(args)
      if (!args || args.length === 0) {
        more = false
        continue
      }
      const arg = args.shift()

      if (arg.startsWith('func')) {
        result.push({isFunc: true, name: arg, identifier: '', type: this.parseType(arg)})
        continue
      }
      if (!arg.includes(' ')) {
        result.push({isFunc: false, name: arg, identifier: '', type: arg})
        continue
      }

      const split = arg.split(' ')
      if (!split || split.length < 2) {
        continue
      }

      let identifier = split.shift()
      let type = split.join(' ')
      let isFunc = false
      if (type.startsWith('func')) {
        type = this.parseType(split.join(' '))
        isFunc = true
      }
      result.push({isFunc: isFunc, name: arg, identifier: identifier, type: type})
    }

    return result
  }

  upgradeSuggestion (suggestion: Suggestion, c: GoCodeSuggestion): FuzzySuggestion {
    if (!c || !c.type || c.type === '' || !c.type.includes('func(')) {
      return {...suggestion}
    }
    const type = this.parseType(c.type)
    if (!type || !type.isFunc) {
      return {...suggestion, leftLabel: ''}
    }
    suggestion.leftLabel = ''
    if (type.returns && type.returns.length > 0) {
      if (type.returns.length === 1) {
        suggestion.leftLabel = type.returns[0].name
      } else {
        suggestion.leftLabel = '('
        for (const r of type.returns) {
          if (suggestion.leftLabel === '(') {
            suggestion.leftLabel = suggestion.leftLabel + r.name
          } else {
            suggestion.leftLabel = suggestion.leftLabel + ', ' + r.name
          }
        }
        suggestion.leftLabel = suggestion.leftLabel + ')'
      }
    }
    const res = this.generateSnippet(c.name, type)
    return {
      ...suggestion,
      snippet: res.snippet,
      displayText: res.displayText,
      fuzzyMatch: c.name
    }
  }

  funcSnippet (result: Snippet, snipCount: number, argCount: number, param: GoParam) {
    // Generate an anonymous func
    let identifier = param.identifier
    if (!identifier || !identifier.length) {
      identifier = 'arg' + argCount
    }
    snipCount = snipCount + 1
    result.snippet = result.snippet + '${' + snipCount + ':'
    result.snippet = result.snippet + 'func('
    result.displayText = result.displayText + 'func('
    let internalArgCount = 0
    let args = []
    if (typeof param.type !== 'string') {
      args = param.type.args || []
    }
    for (const arg of args) {
      internalArgCount = internalArgCount + 1
      if (internalArgCount !== 1) {
        result.snippet = result.snippet + ', '
        result.displayText = result.displayText + ', '
      }

      snipCount = snipCount + 1
      let argText = 'arg' + argCount + ''
      if (arg.identifier && arg.identifier.length > 0) {
        argText = arg.identifier + ''
      }
      result.snippet = result.snippet + '${' + snipCount + ':' + argText + '} '
      result.displayText = result.displayText + argText + ' '
      if (arg.isFunc) {
        const r = this.funcSnippet(result, snipCount, argCount, arg)
        result = r.result
        snipCount = r.snipCount
        argCount = r.argCount
      } else if (typeof arg.type === 'string') {
        let argType: string = arg.type
        const orig = argType
        if (argType.endsWith('{}')) {
          argType = argType.substring(0, argType.length - 1) + '\\}'
        }
        result.snippet = result.snippet + argType
        result.displayText = result.displayText + orig
      }
    }

    result.snippet = result.snippet + ')'
    result.displayText = result.displayText + ')'
    if (typeof param.type !== 'string') {
      const paramType: GoType = param.type
      if (paramType.returns && paramType.returns.length) {
        if (paramType.returns.length === 1) {
          if (paramType.returns[0].isFunc) {
            result.snippet = result.snippet + ' '
            result.displayText = result.displayText + ' '
            const r = this.funcSnippet(result, snipCount, argCount, paramType.returns[0])
            result = r.result
            snipCount = r.snipCount
            argCount = r.argCount
          } else if (typeof paramType.returns[0].type === 'string') {
            result.snippet = result.snippet + ' ' + paramType.returns[0].type
            if (result.snippet.endsWith('{}')) {
              result.snippet = result.snippet.substring(0, result.snippet.length - 1) + '\\}'
            }
            if (paramType.returns) {
              result.displayText = result.displayText + ' ' + paramType.returns[0].name
            }
          }
        } else {
          let returnCount = 0
          result.snippet = result.snippet + ' ('
          result.displayText = result.displayText + ' ('
          for (const returnItem of paramType.returns) {
            returnCount = returnCount + 1
            if (returnCount !== 1) {
              result.snippet = result.snippet + ', '
              result.displayText = result.displayText + ', '
            }
            if (typeof returnItem.type === 'string') {
              let returnType = returnItem.type
              if (returnType.endsWith('{}')) {
                returnType = returnType.substring(0, returnType.length - 1) + '\\}'
              }
              result.snippet = result.snippet + returnType
            }
            result.displayText = result.displayText + returnItem.name
          }
          result.snippet = result.snippet + ')'
          result.displayText = result.displayText + ')'
        }
      }
    }
    snipCount = snipCount + 1
    result.snippet = result.snippet + ' {\n\t$' + snipCount + '\n\\}}'
    return {
      result: result,
      snipCount: snipCount,
      argCount: argCount
    }
  }

  generateSnippet (name: string, type: ?GoType): Snippet {
    let result = {
      snippet: name + '(',
      displayText: name + '('
    }

    if (!type) {
      result.snippet = result.snippet + ')$0'
      result.displayText = result.displayText + ')'
      return result
    }
    let snipCount = 0
    if (type.args && type.args.length) {
      for (let argCount = 0; argCount < type.args.length; argCount++) {
        const arg = type.args[argCount]

        // omit variadic arguments
        const generateArgSnippet = !(argCount === type.args.length - 1 && typeof arg.type === 'string' && arg.type.startsWith('...'))

        if (argCount !== 0) {
          if (generateArgSnippet) { result.snippet = result.snippet + ', ' }
          result.displayText = result.displayText + ', '
        }
        if (arg.isFunc) {
          const r = this.funcSnippet(result, snipCount, argCount, arg)
          result = r.result
          snipCount = r.snipCount
          argCount = r.argCount
        } else {
          let argText = arg.name
          if (this.snippetMode === 'name' && arg.identifier && arg.identifier.length) {
            argText = arg.identifier
          }
          if (argText.endsWith('{}')) {
            argText = argText.substring(0, argText.length - 1) + '\\}'
          }
          snipCount = snipCount + 1
          if (generateArgSnippet) { result.snippet = result.snippet + '${' + snipCount + ':' + argText + '}' }
          result.displayText = result.displayText + arg.name
        }
      }
    }
    result.snippet = result.snippet + ')$0'
    result.displayText = result.displayText + ')'
    if (this.snippetMode === 'none') {
      // user doesn't care about arg names/types
      result.snippet = name + '($1)$0'
    }
    return result
  }

  bounceGocode () {
    if (this.panicked) {
      return
    }

    this.panicked = true
    const notification = atom.notifications.addError('gocode', {
      dismissable: true,
      icon: 'flame',
      detail: 'gocode is panicking',
      description: 'This often happens when you install a new go version, or when you are running an out of date version of `gocode`.' + os.EOL + os.EOL + 'See the <a href="https://github.com/joefitzgerald/go-plus/wiki/FAQ#help-the-only-autocomplete-suggestion-that-i-am-receiving-is-panic">FAQ</a> for more information.' + os.EOL + os.EOL + 'Often, running `gocode close && go get -u github.com/nsf/gocode` is able to fix the issue.' + os.EOL + os.EOL + 'If this does not work and you are definitely running the latest version of `gocode`, you might want to search for open issues at <a href="https://github.com/nsf/gocode/issues?utf8=%E2%9C%93&q=is%3Aissue%20is%3Aopen%20panic">https://github.com/nsf/gocode/issues</a>.' + os.EOL + os.EOL + 'Would you like to try running `gocode close && go get -u github.com/nsf/gocode` now?',
      buttons: [{
        text: 'Yes',
        onDidClick: () => {
          notification.dismiss()
          atom.commands.dispatch(atom.views.getView(atom.workspace), 'golang:update-tools', ['github.com/nsf/gocode'])
        }
      }, {
        text: 'Not Now',
        onDidClick: () => {
          notification.dismiss()
        }
      }]
    })
  }
}
export {GocodeProvider}
