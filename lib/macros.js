import {EvaluationError, ParseError} from './errors.js'
import {OPERATORS as OPS} from './operators.js'
const identity = (x) => x

function assertIdentifier(node, message) {
  if (node.op === 'id') return node.args
  throw new ParseError(message, node)
}

function createMapExpander(hasFilter) {
  const functionDesc = hasFilter ? 'map(var, filter, transform)' : 'map(var, transform)'
  const invalidMsg = `${functionDesc} invalid predicate iteration variable`
  const label = `${functionDesc} filter predicate must return bool`

  return ({args, receiver, ast: callAst}) => {
    const [iterVar, predicate, transform] = hasFilter ? args : [args[0], null, args[1]]

    let step = transform.clone(OPS.accuPush, transform)
    if (predicate) {
      const accuValue = predicate.clone(OPS.accuValue)
      step = predicate.clone(OPS.ternary, [predicate.setMeta('label', label), step, accuValue])
    }

    return {
      callAst: callAst.clone(OPS.comprehension, {
        errorsAreFatal: true,
        iterable: receiver,
        iterVarName: assertIdentifier(iterVar, invalidMsg),
        init: callAst.clone(OPS.list, []),
        step,
        result: identity
      })
    }
  }
}

function createFilterExpander() {
  const functionDesc = 'filter(var, predicate)'
  const invalidMsg = `${functionDesc} invalid predicate iteration variable`
  const label = `${functionDesc} predicate must return bool`

  return ({args, receiver, ast: callAst}) => {
    const iterVarName = assertIdentifier(args[0], invalidMsg)
    const accuValue = callAst.clone(OPS.accuValue)
    const predicate = args[1].setMeta('label', label)
    const appendItem = callAst.clone(OPS.accuPush, callAst.clone(OPS.id, iterVarName))
    const step = predicate.clone(OPS.ternary, [predicate, appendItem, accuValue])

    return {
      callAst: callAst.clone(OPS.comprehension, {
        errorsAreFatal: true,
        iterable: receiver,
        iterVarName,
        init: callAst.clone(OPS.list, []),
        step,
        result: identity
      })
    }
  }
}

function createQuantifierExpander(opts) {
  const invalidMsg = `${opts.name}(var, predicate) invalid predicate iteration variable`
  const label = `${opts.name}(var, predicate) predicate must return bool`
  return ({args, receiver, ast: callAst}) => {
    const predicate = args[1].setMeta('label', label)
    const transform = opts.transform({args, ast: callAst, predicate, opts})

    return {
      callAst: callAst.clone(OPS.comprehension, {
        kind: 'quantifier',
        errorsAreFatal: opts.errorsAreFatal || false,
        iterable: receiver,
        iterVarName: assertIdentifier(args[0], invalidMsg),
        init: transform.init,
        condition: transform.condition,
        step: transform.step,
        result: transform.result || identity
      })
    }
  }
}

function createHasExpander() {
  const invalidHasArgument = 'has() invalid argument'

  function evaluate(ev, macro, ctx) {
    const nodes = macro.macroHasProps
    let i = nodes.length
    let obj = ev.eval(nodes[--i], ctx)
    let inOptionalContext
    while (i--) {
      const node = nodes[i]
      if (node.op === '.?') inOptionalContext ??= true
      obj = ev.debugType(obj).fieldLazy(obj, node.args[1], node, ev)
      if (obj !== undefined) continue
      if (!(!inOptionalContext && i && node.op === '.')) break
      throw new EvaluationError(`No such key: ${node.args[1]}`, node)
    }
    return obj !== undefined
  }

  function typeCheck(checker, macro, ctx) {
    let node = macro.args[0]
    if (node.op !== '.') throw new checker.Error(invalidHasArgument, node)
    if (!macro.macroHasProps) {
      const props = []
      while (node.op === '.' || node.op === '.?') node = props.push(node) && node.args[0]
      if (node.op !== 'id') throw new checker.Error(invalidHasArgument, node)
      checker.check(node, ctx)
      props.push(node)
      macro.macroHasProps = props
    }
    return checker.getType('bool')
  }

  return function ({args}) {
    return {args, evaluate, typeCheck}
  }
}

export function registerMacros(registry) {
  registry.registerFunctionOverload('has(ast): bool', createHasExpander())

  registry.registerFunctionOverload(
    'list.all(ast, ast): bool',
    createQuantifierExpander({
      name: 'all',
      transform({ast: callAst, predicate, opts}) {
        return {
          init: callAst.clone(OPS.value, true),
          condition: identity,
          step: predicate.clone(OPS.ternary, [
            predicate,
            predicate.clone(OPS.value, true),
            predicate.clone(OPS.value, false)
          ])
        }
      }
    })
  )

  registry.registerFunctionOverload(
    'list.exists(ast, ast): bool',
    createQuantifierExpander({
      name: 'exists',
      condition(accu) {
        return !accu
      },
      transform({ast: callAst, predicate, opts}) {
        return {
          init: callAst.clone(OPS.value, false),
          condition: opts.condition,
          step: predicate.clone(OPS.ternary, [
            predicate,
            predicate.clone(OPS.value, true),
            predicate.clone(OPS.value, false)
          ])
        }
      }
    })
  )

  registry.registerFunctionOverload(
    'list.exists_one(ast, ast): bool',
    createQuantifierExpander({
      name: 'exists_one',
      errorsAreFatal: true,
      result(accu) {
        return accu === 1
      },
      transform({ast: callAst, predicate, opts}) {
        const accuValue = callAst.clone(OPS.accuValue)
        return {
          init: callAst.clone(OPS.value, 0),
          step: predicate.clone(OPS.ternary, [predicate, callAst.clone(OPS.accuInc), accuValue]),
          result: opts.result
        }
      }
    })
  )

  registry.registerFunctionOverload('list.map(ast, ast): list<dyn>', createMapExpander(false))
  registry.registerFunctionOverload('list.map(ast, ast, ast): list<dyn>', createMapExpander(true))
  registry.registerFunctionOverload('list.filter(ast, ast): list<dyn>', createFilterExpander())

  function bindOptionalEvaluate(ev, exp, bindCtx, ctx, boundValue) {
    const res = ev.eval(exp, (ctx = bindCtx.reuse(ctx).setIterValue(boundValue, ev, exp)))
    if (res instanceof Promise && ctx === bindCtx) ctx.async = true
    return res
  }

  class CelNamespace {}
  const celNamespace = new CelNamespace()
  registry.registerType('CelNamespace', CelNamespace)
  registry.registerConstant('cel', 'CelNamespace', celNamespace)

  function bindTypeCheck(checker, macro, ctx) {
    macro.bindCtx = ctx.forkWithVariable(macro.var, checker.check(macro.val, ctx))
    return checker.check(macro.exp, macro.bindCtx)
  }

  function bindEvaluate(ev, {val, exp, bindCtx}, ctx) {
    const v = ev.eval(val, ctx)
    if (v instanceof Promise) return v.then((_v) => bindOptionalEvaluate(ev, exp, bindCtx, ctx, _v))
    return bindOptionalEvaluate(ev, exp, bindCtx, ctx, v)
  }

  registry.registerFunctionOverload('CelNamespace.bind(ast, dyn, ast): dyn', ({args}) => {
    return {
      var: assertIdentifier(args[0], 'invalid variable argument'),
      val: args[1],
      exp: args[2],
      bindCtx: undefined,
      typeCheck: bindTypeCheck,
      evaluate: bindEvaluate
    }
  })
}
