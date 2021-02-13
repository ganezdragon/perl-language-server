import { Range } from "vscode-languageserver/node";
import { SyntaxNode } from "web-tree-sitter";

/**
 * For each syntax node, analyze each of its children
 * 
 * @function forEachNodeAnalyze
 * @param node the syntax node
 * @param callBack the callBack function to execute
 */
function forEachNodeAnalyze(node: SyntaxNode, callBack: (nodeInCallBack: SyntaxNode) => void): void {
  callBack(node);

  // Only analyze the node if its children has either error or missing node
  if (node.childCount && (node.hasError() || node.isMissing())) {
    node.children.forEach((currentChildNode) => {
      forEachNodeAnalyze(currentChildNode, callBack);
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

export {
  forEachNodeAnalyze,
  forEachNode,
  getRangeForNode,
}
