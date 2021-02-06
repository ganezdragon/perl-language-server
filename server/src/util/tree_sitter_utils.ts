import { Range } from "vscode-languageserver/node";
import { SyntaxNode } from "web-tree-sitter";

function forEachNodeAnalyze(node: SyntaxNode, callBack: (nodeInCallBack: SyntaxNode) => void): void {
  callBack(node);

  // Only analyze the node if its children has either error or missing node
  if (node.childCount && (node.hasError() || node.isMissing())) {
    node.children.forEach((currentChildNode) => {
      forEachNodeAnalyze(currentChildNode, callBack);
    });
  }
}

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
  getRangeForNode,
}
