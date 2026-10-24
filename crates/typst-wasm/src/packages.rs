//! Finding the packages a project depends on.
//!
//! [`World`](typst::World) is synchronous, so the compiler cannot pause to
//! download a package the way the CLI can. Instead the host scans the loaded
//! sources for package imports, fetches what is missing, pushes the files in,
//! and only then compiles.
//!
//! Scanning looks at string literals in `import` and `include` statements.
//! An import whose path is computed — `#import "@preview/" + name` — is not
//! found, and compiling then reports the package as missing. Every package
//! import in practice is a literal, and Typst requires an exact version in it.

use std::collections::HashSet;

use typst::syntax::ast;
use typst::syntax::package::PackageSpec;
use typst::syntax::{Source, SyntaxKind, SyntaxNode};

/// Collects the package specs referenced by a source file.
///
/// Unordered: `PackageSpec` is hashable but not orderable, so callers that
/// need a stable list sort the rendered strings.
pub fn referenced_packages(source: &Source) -> HashSet<PackageSpec> {
    let mut found = HashSet::new();
    visit(source.root(), &mut found);
    found
}

fn visit(node: &SyntaxNode, found: &mut HashSet<PackageSpec>) {
    let path = match node.kind() {
        SyntaxKind::ModuleImport => node
            .cast::<ast::ModuleImport>()
            .map(|import| import.source()),
        SyntaxKind::ModuleInclude => node
            .cast::<ast::ModuleInclude>()
            .map(|include| include.source()),
        _ => None,
    };

    if let Some(ast::Expr::Str(literal)) = path {
        let value = literal.get();
        // Only `@`-prefixed paths are packages; everything else is a file in
        // the project, which the host already has.
        if value.starts_with('@') {
            if let Ok(spec) = value.parse::<PackageSpec>() {
                found.insert(spec);
            }
        }
    }

    for child in node.children() {
        visit(child, found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::DEFAULT_MAIN;
    use typst::syntax::VirtualPath;
    use typst::syntax::{RootedPath, VirtualRoot};

    fn scan(text: &str) -> Vec<String> {
        let id = RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new(DEFAULT_MAIN).unwrap(),
        )
        .intern();
        let source = Source::new(id, text.to_string());
        let mut found: Vec<String> = referenced_packages(&source)
            .iter()
            .map(|spec| spec.to_string())
            .collect();
        found.sort();
        found
    }

    #[test]
    fn finds_a_plain_import() {
        assert_eq!(
            scan(r#"#import "@preview/cetz:0.3.1""#),
            vec!["@preview/cetz:0.3.1"]
        );
    }

    #[test]
    fn finds_an_import_with_bindings() {
        assert_eq!(
            scan(r#"#import "@preview/tablex:0.0.8": tablex, cellx"#),
            vec!["@preview/tablex:0.0.8"]
        );
    }

    #[test]
    fn finds_an_include() {
        assert_eq!(
            scan(r#"#include "@preview/example:1.2.3""#),
            vec!["@preview/example:1.2.3"]
        );
    }

    #[test]
    fn finds_several_and_deduplicates() {
        let found = scan(
            r#"
            #import "@preview/a:1.0.0"
            #import "@preview/b:2.0.0": thing
            #import "@preview/a:1.0.0": other
            "#,
        );
        assert_eq!(found, vec!["@preview/a:1.0.0", "@preview/b:2.0.0"]);
    }

    #[test]
    fn ignores_project_relative_imports() {
        assert!(scan(r#"#import "/chapter.typ": *"#).is_empty());
        assert!(scan(r#"#include "sub/part.typ""#).is_empty());
    }

    #[test]
    fn ignores_a_malformed_spec() {
        // No version, so it is not a package Typst could resolve.
        assert!(scan(r#"#import "@preview/nope""#).is_empty());
    }

    #[test]
    fn handles_a_namespace_other_than_preview() {
        assert_eq!(
            scan(r#"#import "@local/mine:0.1.0""#),
            vec!["@local/mine:0.1.0"]
        );
    }

    #[test]
    fn finds_an_import_nested_in_a_block() {
        assert_eq!(
            scan("#{\n  import \"@preview/deep:0.1.0\"\n}"),
            vec!["@preview/deep:0.1.0"]
        );
    }

    #[test]
    fn ignores_a_string_that_merely_looks_like_a_spec() {
        assert!(scan(r#"This mentions "@preview/cetz:0.3.1" in prose."#).is_empty());
        assert!(scan(r#"#let s = "@preview/cetz:0.3.1""#).is_empty());
    }
}
