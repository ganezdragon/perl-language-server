import { Range } from "vscode-languageserver/node";
import { SyntaxNode } from "web-tree-sitter";

/**
 * For each syntax node, analyze each of its children
 * 
 * @function forEachNodeAnalyze
 * @param node the syntax node
 * @param callBack the callBack function to execute
 */
function forEachNodeAnalyze(isRootNode: boolean, node: SyntaxNode, callBack: (nodeInCallBack: SyntaxNode) => void): void {
  if (!isRootNode) {
    callBack(node);
  }

  // Only analyze the node if its children has either error or missing node
  if (node.childCount && (node.hasError || node.isMissing)) {
    node.children.forEach((currentChildNode) => {
      forEachNodeAnalyze(false, currentChildNode, callBack);
    });
  }
}

/**
 * Given a node, executes the callBack function for each of its
 * children.
 * 
 * @function forEachNode
 * @param node the syntax node
 * @param callBack the callBack function to execute
 */
function forEachNode(node: SyntaxNode, callBack: (nodeInCallBack: SyntaxNode) => void): void {
  callBack(node);

  if (node.childCount) {
    node.children.forEach(currentChildNode => {
      forEachNode(currentChildNode, callBack);
    })
  }
}

/**
 * For a given node, returns back the range
 * 
 * @function getRangeForNode
 * @param node the syntax node
 * @returns Range
 */
function getRangeForNode(node: SyntaxNode): Range {
  return Range.create(
    node.startPosition.row,
    node.startPosition.column,
    node.endPosition.row,
    node.endPosition.column,
  );
}

/**
 * Given a node, recursively finds the first package that its under.
 * Could return null if not found (probably a pl file?)
 * 
 * @param node the node for which the encapsulating package to be found
 * @returns a SyntaxNode or Null
 */
function getPackageNodeForNode(node: SyntaxNode): SyntaxNode | null {
  const package_statements: SyntaxNode[] = node.descendantsOfType("package_statement")

  // return the last package that you encouter
  return package_statements.length > 0 ? package_statements[package_statements.length - 1] : node.parent !== null ? getPackageNodeForNode(node.parent) : null;
}

export {
  forEachNodeAnalyze,
  forEachNode,
  getRangeForNode,
  getPackageNodeForNode
}
