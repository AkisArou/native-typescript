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

/** One compiled ScriptC runtime object, named so a build can declare it. */
export interface ScriptCExternalRuntimeObject {
  readonly id: string;
  readonly fileName: string;
}

/**
 * A native build as a sequence of driver commands.
 *
 * The runtime compiles per source and the program links against those objects,
 * so the two are cached at their own boundaries: the runtime depends on the
 * pinned checkout and the toolchain, the program on the application. Combining
 * them in one command made an application edit invalidate the runtime as well.
 */
export interface ScriptCExternalBuild {
  /** Runtime object compiles first, then the link that consumes them. */
  readonly plans: readonly ScriptCExternalCcPlan[];
  readonly runtimeObjects: readonly ScriptCExternalRuntimeObject[];
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
