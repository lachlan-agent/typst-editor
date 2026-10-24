//! The compile engine: a long-lived [`WebWorld`] plus the operations the
//! editor drives it with.
//!
//! This module is platform-neutral so that the native test suite exercises
//! exactly the code the browser runs. The `wasm_bindgen` layer in `lib.rs` is
//! a thin wrapper over it.

use std::collections::BTreeSet;

use serde::Serialize;
use typst::diag::{Severity, SourceDiagnostic, Warned};
use typst::syntax::LinkedNode;
use typst::{World, WorldExt};
use typst_layout::PagedDocument;
use typst_svg::SvgOptions;

use crate::world::{WebWorld, DEFAULT_MAIN};

/// A diagnostic mapped into editor coordinates.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Diagnostic {
    /// `"error"` or `"warning"`.
    pub severity: &'static str,
    pub message: String,
    /// Path of the file the span points into, if any.
    pub path: Option<String>,
    /// Byte offsets into that file. `None` when the diagnostic is detached.
    pub from: Option<usize>,
    pub to: Option<usize>,
    pub hints: Vec<String>,
}

/// The result of a preview compile.
#[derive(Debug, Clone, Serialize)]
pub struct SvgOutput {
    /// One SVG document per page. Empty if compilation failed.
    pub pages: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
}

/// The result of a PDF export.
#[derive(Debug, Clone, Serialize)]
pub struct PdfOutput {
    /// Serialized as a `Uint8Array` rather than an array of numbers, which is
    /// what a plain `Vec<u8>` would become.
    #[serde(with = "serde_bytes")]
    pub data: Option<Vec<u8>>,
    pub diagnostics: Vec<Diagnostic>,
}

/// A syntax-highlighting token.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Token {
    pub from: usize,
    pub to: usize,
    /// The lowercased [`typst::syntax::highlight::Tag`] name, e.g. `"heading"`.
    pub tag: &'static str,
}

/// A completion offered at the cursor.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Completion {
    /// `"func"`, `"type"`, `"label"`, `"symbol"`, and so on.
    pub kind: String,
    pub label: String,
    /// The text to insert, which may differ from the label and may carry
    /// `${...}` placeholders.
    pub apply: Option<String>,
    /// A one-line description, shown beside the label.
    pub detail: Option<String>,
}

/// The completions available at a cursor position.
#[derive(Debug, Clone, Serialize)]
pub struct Completions {
    /// Byte offset where the replaced text starts.
    pub from: usize,
    pub items: Vec<Completion>,
}

/// Documentation for the expression under the cursor.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hover {
    /// `"text"` for prose, `"code"` for a Typst snippet.
    pub kind: &'static str,
    pub value: String,
}

pub struct Engine {
    world: WebWorld,
    /// The most recent successful compilation.
    ///
    /// Completions and tooltips are markedly better with it: labels,
    /// references and cross-file bibliography entries only exist once the
    /// document has been laid out. Kept from the last *successful* compile so
    /// the help does not vanish the moment the source has a syntax error.
    document: Option<PagedDocument>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            world: WebWorld::new(),
            document: None,
        }
    }

    pub fn world_mut(&mut self) -> &mut WebWorld {
        &mut self.world
    }

    pub fn world(&self) -> &WebWorld {
        &self.world
    }

    /// Compiles the main file to one SVG document per page.
    pub fn compile_svg(&mut self) -> SvgOutput {
        let Warned { output, warnings } = typst::compile::<PagedDocument>(&self.world);
        let opts = SvgOptions::default();
        match output {
            Ok(document) => {
                let pages = document
                    .pages()
                    .iter()
                    .map(|page| typst_svg::svg(page, &opts))
                    .collect();
                let diagnostics = self.convert(warnings.iter());
                self.document = Some(document);
                SvgOutput { pages, diagnostics }
            }
            Err(errors) => SvgOutput {
                pages: Vec::new(),
                diagnostics: self.convert(errors.iter().chain(warnings.iter())),
            },
        }
    }

    /// Compiles the main file to a PDF.
    #[cfg(feature = "pdf")]
    pub fn compile_pdf(&self) -> PdfOutput {
        let Warned { output, warnings } = typst::compile::<PagedDocument>(&self.world);
        let document = match output {
            Ok(document) => document,
            Err(errors) => {
                return PdfOutput {
                    data: None,
                    diagnostics: self.convert(errors.iter().chain(warnings.iter())),
                }
            }
        };

        match typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default()) {
            Ok(data) => PdfOutput {
                data: Some(data),
                diagnostics: self.convert(warnings.iter()),
            },
            Err(errors) => PdfOutput {
                data: None,
                diagnostics: self.convert(errors.iter().chain(warnings.iter())),
            },
        }
    }

    /// Produces highlighting tokens for a source file.
    ///
    /// Returns an empty list for files that aren't known text files.
    pub fn highlight(&self, path: &str) -> Vec<Token> {
        let Ok(source) = self.world.source(crate::world::file_id(path)) else {
            return Vec::new();
        };
        let mut tokens = Vec::new();
        collect_tokens(&LinkedNode::new(source.root()), &mut tokens);
        tokens
    }

    /// Completions for the cursor position in a file.
    ///
    /// `cursor` is a byte offset. `explicit` is true when the user asked for
    /// completions directly (Ctrl-Space) rather than by typing, which makes
    /// Typst offer a broader set.
    pub fn autocomplete(&self, path: &str, cursor: usize, explicit: bool) -> Completions {
        let Ok(source) = self.world.source(crate::world::file_id(path)) else {
            return Completions {
                from: cursor,
                items: Vec::new(),
            };
        };
        // A cursor past the end, or inside a character, would panic in the
        // tokenizer; clamping to a boundary is cheaper than trusting the host.
        let cursor = clamp_to_char_boundary(source.text(), cursor);

        match typst_ide::autocomplete(
            &self.world,
            self.document.as_ref(),
            &source,
            cursor,
            explicit,
        ) {
            Some((from, items)) => Completions {
                from,
                items: items.into_iter().map(convert_completion).collect(),
            },
            None => Completions {
                from: cursor,
                items: Vec::new(),
            },
        }
    }

    /// Documentation for whatever sits under the cursor.
    pub fn hover(&self, path: &str, cursor: usize) -> Option<Hover> {
        let source = self.world.source(crate::world::file_id(path)).ok()?;
        let cursor = clamp_to_char_boundary(source.text(), cursor);

        let tooltip = typst_ide::tooltip(
            &self.world,
            self.document.as_ref(),
            &source,
            cursor,
            typst::syntax::Side::Before,
        )?;
        Some(match tooltip {
            typst_ide::Tooltip::Text(text) => Hover {
                kind: "text",
                value: text.to_string(),
            },
            typst_ide::Tooltip::Code(code) => Hover {
                kind: "code",
                value: code.to_string(),
            },
        })
    }

    /// The packages referenced by loaded sources that are not yet present.
    ///
    /// Scanning covers package sources too, so a package that imports another
    /// package surfaces on the next round: the host loops until this returns
    /// nothing.
    pub fn missing_packages(&self) -> Vec<String> {
        let mut missing = BTreeSet::new();
        for source in self.world.sources() {
            for spec in crate::packages::referenced_packages(source) {
                if !self.world.has_package(&spec) {
                    missing.insert(spec.to_string());
                }
            }
        }
        missing.into_iter().collect()
    }

    /// Releases memoized results that haven't been touched for `max_age`
    /// compilations.
    pub fn evict(&self, max_age: usize) {
        comemo::evict(max_age);
    }

    /// Formats Typst source with typstyle. A document that does not parse
    /// is left alone: the error names why.
    pub fn format(&self, text: &str, max_width: usize, tab_spaces: usize) -> Result<String, String> {
        let config = typstyle_core::Config::new()
            .with_width(max_width)
            .with_tab_spaces(tab_spaces);
        typstyle_core::Typstyle::new(config)
            .format_text(text)
            .render()
            .map_err(|err| err.to_string())
    }

    fn convert<'a>(
        &self,
        diagnostics: impl Iterator<Item = &'a SourceDiagnostic>,
    ) -> Vec<Diagnostic> {
        diagnostics.map(|diag| self.convert_one(diag)).collect()
    }

    fn convert_one(&self, diag: &SourceDiagnostic) -> Diagnostic {
        let range = self.world.range(diag.span);
        Diagnostic {
            severity: match diag.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
            },
            message: diag.message.to_string(),
            path: self.span_path(diag.span),
            from: range.as_ref().map(|r| r.start),
            to: range.as_ref().map(|r| r.end),
            hints: diag.hints.iter().map(|hint| hint.v.to_string()).collect(),
        }
    }

    fn span_path(&self, span: typst::syntax::DiagSpan) -> Option<String> {
        span_file_id(span).map(WebWorld::path_of)
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

/// Extracts the file a diagnostic span points into, if any.
fn span_file_id(span: typst::syntax::DiagSpan) -> Option<typst::syntax::FileId> {
    use typst::syntax::DiagSpanKind;
    match span.get() {
        DiagSpanKind::Detached => None,
        DiagSpanKind::Number { id, .. } => Some(id),
        DiagSpanKind::Range { id, .. } => Some(id),
    }
}

/// Walks the syntax tree, emitting a token for every node that carries a tag.
///
/// Tagged nodes are not always leaves (a heading tags its whole span), so a
/// tagged node's children are not descended into — that would paint the same
/// range twice.
fn collect_tokens(node: &LinkedNode, out: &mut Vec<Token>) {
    if let Some(tag) = typst::syntax::highlight(node) {
        let range = node.range();
        out.push(Token {
            from: range.start,
            to: range.end,
            tag: tag_name(tag),
        });
        return;
    }
    for child in node.children() {
        collect_tokens(&child, out);
    }
}

fn convert_completion(completion: typst_ide::Completion) -> Completion {
    use typst_ide::CompletionKind;
    let kind = match &completion.kind {
        CompletionKind::Syntax => "syntax".to_string(),
        CompletionKind::Func => "func".to_string(),
        CompletionKind::Type => "type".to_string(),
        CompletionKind::Param => "param".to_string(),
        CompletionKind::Constant => "constant".to_string(),
        CompletionKind::Path => "path".to_string(),
        CompletionKind::Package => "package".to_string(),
        CompletionKind::Label => "label".to_string(),
        CompletionKind::Font => "font".to_string(),
        // The payload is the symbol itself, e.g. "→" for `arrow.r`, which is
        // worth showing next to the name.
        CompletionKind::Symbol(glyph) => format!("symbol:{glyph}"),
    };
    Completion {
        kind,
        label: completion.label.to_string(),
        apply: completion.apply.map(|text| text.to_string()),
        detail: completion.detail.map(|text| text.to_string()),
    }
}

/// Moves an offset back to the nearest character boundary.
///
/// Byte offsets arrive from JavaScript, where they were converted from UTF-16
/// positions; a cursor between the halves of a multi-byte character would
/// otherwise panic inside the parser.
fn clamp_to_char_boundary(text: &str, cursor: usize) -> usize {
    let mut cursor = cursor.min(text.len());
    while !text.is_char_boundary(cursor) {
        cursor -= 1;
    }
    cursor
}

fn tag_name(tag: typst::syntax::Tag) -> &'static str {
    use typst::syntax::Tag;
    match tag {
        Tag::Comment => "comment",
        Tag::Punctuation => "punctuation",
        Tag::Escape => "escape",
        Tag::Strong => "strong",
        Tag::Emph => "emph",
        Tag::Link => "link",
        Tag::Raw => "raw",
        Tag::Label => "label",
        Tag::Ref => "ref",
        Tag::Heading => "heading",
        Tag::ListMarker => "list-marker",
        Tag::ListTerm => "list-term",
        Tag::MathDelimiter => "math-delimiter",
        Tag::MathOperator => "math-operator",
        Tag::MathGroupingParens => "math-grouping-parens",
        Tag::Keyword => "keyword",
        Tag::Operator => "operator",
        Tag::Number => "number",
        Tag::String => "string",
        Tag::Function => "function",
        Tag::Interpolated => "interpolated",
        Tag::Error => "error",
    }
}

/// The document a fresh editor session starts from.
pub const STARTER_DOCUMENT: &str = include_str!("starter.typ");

/// The path of the default main file, re-exported for the host.
pub const STARTER_PATH: &str = DEFAULT_MAIN;
