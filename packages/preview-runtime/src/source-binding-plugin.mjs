import ts from 'typescript'

export function sourceBindingPlugin(bindings, runtimeModule) {
  const configured = new Map(bindings.map(binding => [binding.entryPath.replaceAll('\\', '/'), binding]))
  return {
    name: 'design-editor-source-bindings',
    /** @type {'pre'} Bind exports before JSX compilation to preserve component identity. */
    enforce: 'pre',
    transform(source, moduleId) {
      const binding = configured.get(moduleId.split('?')[0].replaceAll('\\', '/'))
      if (!binding) return null
      const file = ts.createSourceFile(moduleId, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === binding.exportName && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      if (!declaration || declaration.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) throw new Error('This component export needs a verified source binding adapter: ' + binding.exportName)
      const local = '__DesignEditorBound_' + binding.exportName
      if (source.includes(local) || source.includes('__DesignEditorBind')) throw new Error('Source binding name conflicts with the imported module.')
      const result = ts.transpileModule(source, {
        fileName: moduleId,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, sourceMap: true, inlineSources: true },
        transformers: { before: [() => input => {
          const factory = ts.factory
          const rewritten = input.statements.map(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === binding.exportName ? factory.updateFunctionDeclaration(statement, statement.modifiers.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword), statement.asteriskToken, statement.name, statement.typeParameters, statement.parameters, statement.type, statement.body) : statement)
          const runtimeImport = factory.createImportDeclaration(undefined, factory.createImportClause(false, undefined, factory.createNamedImports([factory.createImportSpecifier(false, factory.createIdentifier('bindSourceComponent'), factory.createIdentifier('__DesignEditorBind'))])), factory.createStringLiteral(runtimeModule))
          const wrapper = factory.createVariableStatement(undefined, factory.createVariableDeclarationList([factory.createVariableDeclaration(local, undefined, undefined, factory.createCallExpression(factory.createIdentifier('__DesignEditorBind'), undefined, [factory.createStringLiteral(binding.componentId), factory.createStringLiteral(binding.exportName), factory.createIdentifier(binding.exportName)]))], ts.NodeFlags.Const))
          const exported = factory.createExportDeclaration(undefined, false, factory.createNamedExports([factory.createExportSpecifier(false, factory.createIdentifier(local), factory.createIdentifier(binding.exportName))]))
          return factory.updateSourceFile(input, [runtimeImport, ...rewritten, wrapper, exported])
        }] },
      })
      const metadata = result.outputText.lastIndexOf('//# sourceMappingURL=')
      return { code: metadata < 0 ? result.outputText : result.outputText.slice(0, metadata), map: JSON.parse(result.sourceMapText) }
    },
  }
}

