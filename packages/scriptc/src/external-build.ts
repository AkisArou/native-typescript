export type ScriptCExternalCcArgument =
  | { readonly kind: "literal"; readonly value: string }
  | {
      readonly kind: "input-path";
      readonly input: string;
      readonly path?: string;
    }
  | { readonly kind: "output-path"; readonly output: string };

export interface ScriptCExternalCcPlan {
  readonly schema: "scriptc.external-cc-plan";
  readonly schemaVersion: 1;
  readonly driver: {
    readonly command: string;
  };
  readonly targetPlatform: string;
  readonly inputs: readonly string[];
  readonly output: string;
  readonly arguments: readonly ScriptCExternalCcArgument[];
}

export interface ScriptCExternalCcPlanResolution {
  readonly plan: ScriptCExternalCcPlan;
  readonly bindings: {
    readonly runtimeDirectory: string;
  };
}
