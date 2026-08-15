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

export interface ScriptCExecutableNativeBuildPlan {
  readonly cacheIdentity?: string;
  readonly sanitize?: boolean;
  readonly linkInputs?: readonly string[];
  readonly systemLibraries?: readonly string[];
  readonly dynamic?: boolean;
  readonly regex?: boolean;
  readonly copying?: boolean;
  readonly textDecoderLegacy?: boolean;
  readonly fileHandle?: boolean;
  readonly nativeHandle?: boolean;
  readonly retainedCallbacks?: boolean;
  readonly fetch?: boolean;
  readonly netIsland?: boolean;
  readonly zlib?: boolean;
  readonly assert?: boolean;
  readonly inspect?: boolean;
  readonly dynInvoke?: boolean;
  readonly dc?: boolean;
  readonly dynAsync?: boolean;
  readonly events?: boolean;
  readonly emitter?: boolean;
  readonly symbol?: boolean;
  readonly searchParams?: boolean;
  readonly qs?: boolean;
  readonly parseArgs?: boolean;
  readonly stream?: boolean;
  readonly net?: boolean;
  readonly http?: boolean;
  readonly http2?: boolean;
  readonly dgram?: boolean;
  readonly watch?: boolean;
  readonly nodeTest?: boolean;
  readonly tls?: boolean;
  readonly tlsCa?: boolean;
}

export interface ScriptCExecutableCompilationPlan {
  readonly schema: "scriptc.executable-compilation-plan";
  readonly schemaVersion: 1;
  readonly backend: "c" | "llvm";
  readonly target: {
    readonly platform: string;
    readonly pointerBits: 32 | 64;
    readonly wasi: boolean;
  };
  readonly ir: string;
  readonly entrySource: string;
  readonly nativeBuild: ScriptCExecutableNativeBuildPlan;
}
