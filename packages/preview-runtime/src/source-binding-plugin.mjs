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
      const declaration = file.statements.find(statement => {
        const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        const named = (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === binding.exportName
          || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === binding.exportName)
        return exported && named
      })
      const exportStatement = file.statements.find(statement => ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some(element => element.name.text === binding.exportName))
      const exportSpecifier = exportStatement?.exportClause.elements.find(element => element.name.text === binding.exportName)
      const localName = declaration ? binding.exportName : exportSpecifier?.propertyName?.text ?? exportSpecifier?.name.text
      if ((!declaration && !exportSpecifier) || declaration?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) || !localName) throw new Error('This component export needs a verified source binding adapter: ' + binding.exportName)
      const local = '__DesignEditorBound_' + binding.exportName
      if (source.includes(local) || source.includes('__DesignEditorBind')) throw new Error('Source binding name conflicts with the imported module.')
      const result = ts.transpileModule(source, {
        fileName: moduleId,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, sourceMap: true, inlineSources: true },
        transformers: { before: [() => input => {
          const factory = ts.factory
          const withoutExport = modifiers => modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword)
          const rewritten = input.statements.flatMap(statement => {
            const directName = (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === binding.exportName
            const variableName = ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === binding.exportName)
            if (directName && ts.isFunctionDeclaration(statement)) return factory.updateFunctionDeclaration(statement, withoutExport(statement.modifiers), statement.asteriskToken, statement.name, statement.typeParameters, statement.parameters, statement.type, statement.body)
            if (directName && ts.isClassDeclaration(statement)) return factory.updateClassDeclaration(statement, withoutExport(statement.modifiers), statement.name, statement.typeParameters, statement.heritageClauses, statement.members)
            if (variableName && ts.isVariableStatement(statement)) return statement.declarationList.declarations.map(item => factory.updateVariableStatement(
              statement,
              ts.isIdentifier(item.name) && item.name.text === binding.exportName ? withoutExport(statement.modifiers) : statement.modifiers,
              factory.updateVariableDeclarationList(statement.declarationList, [item]),
            ))
            if (!declaration && ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
              const elements = statement.exportClause.elements.filter(element => element.name.text !== binding.exportName)
              return elements.length ? factory.updateExportDeclaration(statement, statement.modifiers, statement.isTypeOnly, factory.updateNamedExports(statement.exportClause, elements), statement.moduleSpecifier, statement.attributes) : []
            }
            return statement
          })
          const runtimeImport = factory.createImportDeclaration(undefined, factory.createImportClause(false, undefined, factory.createNamedImports([factory.createImportSpecifier(false, factory.createIdentifier('bindSourceComponent'), factory.createIdentifier('__DesignEditorBind'))])), factory.createStringLiteral(runtimeModule))
          const wrapper = factory.createVariableStatement(undefined, factory.createVariableDeclarationList([factory.createVariableDeclaration(local, undefined, undefined, factory.createCallExpression(factory.createIdentifier('__DesignEditorBind'), undefined, [factory.createStringLiteral(binding.componentId), factory.createStringLiteral(binding.exportName), factory.createIdentifier(localName)]))], ts.NodeFlags.Const))
          const exported = factory.createExportDeclaration(undefined, false, factory.createNamedExports([factory.createExportSpecifier(false, factory.createIdentifier(local), factory.createIdentifier(binding.exportName))]))
          return factory.updateSourceFile(input, [runtimeImport, ...rewritten, wrapper, exported])
        }] },
      })
      const metadata = result.outputText.lastIndexOf('//# sourceMappingURL=')
      return { code: metadata < 0 ? result.outputText : result.outputText.slice(0, metadata), map: JSON.parse(result.sourceMapText) }
    },
  }
}

