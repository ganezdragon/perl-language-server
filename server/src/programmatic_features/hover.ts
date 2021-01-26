import * as vsCodeServer from 'vscode-languageserver';

class HoverImpl {
  async onHover(params: any): Promise<vsCodeServer.Hover | null> {
    if (1) {
      return {
        contents: "well hello beautiful"
      }
    }
    return null;
  }
}

export default HoverImpl;
