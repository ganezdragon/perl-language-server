import { Range, SymbolInformation, TextEdit } from "vscode-languageserver";
import { SyntaxNode } from "web-tree-sitter";
import { getPackageNodeForNode } from "../util/tree_sitter_utils";
import { StatementWithRange } from "../types/common.types";
import { stat } from "fs";

export function getAdditionalEditsForFunctionImports(currentNode: SyntaxNode, functionToImport: SymbolInformation): TextEdit[] | undefined  {
    const additionalEdits: TextEdit[] = [];

    if (!functionToImport.containerName) {
        return additionalEdits;
    }

    const currentScopePackageName: SyntaxNode | null = getPackageNodeForNode(currentNode);

    // if the function is in the same package, no need to import it.
    if (currentScopePackageName?.descendantsOfType("package_name")[0].text == functionToImport.containerName)
        return additionalEdits;

    const statementToInsert: StatementWithRange = getRangeAndStatementToInsert(currentNode, functionToImport.containerName);

    // the package already exists, so exit
    if (statementToInsert.statement === functionToImport.containerName)
        return additionalEdits;

    const packageToInsertOrReplace: string = "use " + functionToImport.containerName + ";\n";

    additionalEdits.push({
        range: statementToInsert.range,
        newText: packageToInsertOrReplace,
    })

   return additionalEdits;
}


function getRangeAndStatementToInsert(currentNode: SyntaxNode, statementToInsert: string): StatementWithRange {
    const rootNode: SyntaxNode = currentNode.tree.rootNode;
    const useNoStatements: SyntaxNode[] = rootNode.descendantsOfType('use_no_statement');
    let statementToReturn: string = statementToInsert;

    if (useNoStatements.length > 0) {
        const statementNode: SyntaxNode | undefined = useNoStatements.find((useNoStatement: SyntaxNode) => {
            return (useNoStatement.child(1)?.text === statementToInsert);
        });
        statementToReturn = statementNode?.child(1)?.text || statementToInsert;
    }

    // check for package statements, and constants, and then import
    return {
        range: Range.create(
            rootNode.startPosition.row,
            rootNode.startPosition.column,
            rootNode.startPosition.row,
            rootNode.startPosition.column,
        ),
        statement: statementToReturn,
    }

}
