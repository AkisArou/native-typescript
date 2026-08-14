import { fileURLToPath } from "node:url";

export interface ScriptCCheckout {
  readonly branch: "native-typescript";
  readonly path: string;
  readonly repository: "https://github.com/AkisArou/scriptc.git";
}

export function locateScriptCCheckout(): ScriptCCheckout {
  return {
    branch: "native-typescript",
    path: fileURLToPath(new URL("../../../third_party/scriptc/", import.meta.url)),
    repository: "https://github.com/AkisArou/scriptc.git",
  };
}

