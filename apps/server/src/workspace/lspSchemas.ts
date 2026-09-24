import * as Schema from "effect/Schema";

const Position = Schema.Struct({ line: Schema.Number, character: Schema.Number });
export const Range = Schema.Struct({ start: Position, end: Position });
const Markup = Schema.Union([
  Schema.String,
  Schema.Struct({
    value: Schema.String,
    kind: Schema.optional(Schema.String),
    language: Schema.optional(Schema.String),
  }),
]);
export const TextEdit = Schema.Struct({ range: Range, newText: Schema.String });
const Completion = Schema.Struct({
  label: Schema.String,
  kind: Schema.optional(Schema.Number),
  sortText: Schema.optional(Schema.String),
  insertText: Schema.optional(Schema.String),
  insertTextFormat: Schema.optional(Schema.Number),
  textEdit: Schema.optional(
    Schema.Union([
      TextEdit,
      Schema.Struct({ insert: Range, replace: Range, newText: Schema.String }),
    ]),
  ),
  additionalTextEdits: Schema.optional(Schema.Array(TextEdit)),
});
export const decodeCompletion = Schema.decodeUnknownSync(
  Schema.Union([Schema.Array(Completion), Schema.Struct({ items: Schema.Array(Completion) })]),
);
export const Diagnostic = Schema.Struct({
  range: Range,
  message: Schema.String,
  code: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  severity: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.String),
});
export const decodeDiagnostics = Schema.decodeUnknownSync(Schema.Array(Diagnostic));
export const decodePublishedDiagnostics = Schema.decodeUnknownSync(
  Schema.Struct({
    uri: Schema.String,
    version: Schema.optional(Schema.Number),
    diagnostics: Schema.Array(Diagnostic),
  }),
);
export const decodePulledDiagnostics = Schema.decodeUnknownSync(
  Schema.Struct({ items: Schema.Array(Diagnostic) }),
);
export const decodeHover = Schema.decodeUnknownSync(
  Schema.Struct({
    range: Schema.optional(Range),
    contents: Schema.Union([Markup, Schema.Array(Markup)]),
  }),
);
const Location = Schema.Union([
  Schema.Struct({ uri: Schema.String, range: Range }),
  Schema.Struct({ targetUri: Schema.String, targetRange: Range, targetSelectionRange: Range }),
]);
export const decodeLocations = Schema.decodeUnknownSync(
  Schema.Union([Location, Schema.Array(Location)]),
);
export const decodeEdits = Schema.decodeUnknownSync(Schema.Array(TextEdit));
export const decodeSignature = Schema.decodeUnknownSync(
  Schema.Struct({
    activeSignature: Schema.optional(Schema.Number),
    activeParameter: Schema.optional(Schema.Number),
    signatures: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        documentation: Schema.optional(Markup),
        parameters: Schema.optional(
          Schema.Array(
            Schema.Struct({
              label: Schema.Union([Schema.String, Schema.Tuple([Schema.Number, Schema.Number])]),
              documentation: Schema.optional(Markup),
            }),
          ),
        ),
      }),
    ),
  }),
);
export const decodeInitialize = Schema.decodeUnknownSync(
  Schema.Struct({ capabilities: Schema.Record(Schema.String, Schema.Unknown) }),
);
export const decodeConfiguration = Schema.decodeUnknownSync(
  Schema.Struct({
    items: Schema.Array(Schema.Struct({ section: Schema.optional(Schema.String) })),
  }),
);
export const decodeServerStatus = Schema.decodeUnknownSync(
  Schema.Struct({ quiescent: Schema.Boolean }),
);
export const markupText = (value: typeof Markup.Type | undefined) =>
  typeof value === "string" ? value : (value?.value ?? "");

export const hoverMarkdown = (value: typeof Markup.Type) =>
  typeof value === "string"
    ? value
    : value.language
      ? `\`\`\`${value.language}\n${value.value}\n\`\`\``
      : value.value;
