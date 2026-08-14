export interface TargetDefinition {
  readonly name: string;
}

export function defineTarget<const Definition extends TargetDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

