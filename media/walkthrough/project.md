# Open an Idris 2 project

Open the folder that contains your package's `.ipkg` file, or any folder of `.idr` files.

- A file belongs to the package of the nearest `.ipkg` found by walking up from the file's folder, the same search the compiler does, even when that `.ipkg` lies above the folder you opened. The compiler works from the `.ipkg`'s directory, where its `sourcedir`, `depends` and `builddir` apply.
- A file with no `.ipkg` above it is a loose file.
- Keep one `.ipkg` per directory: when there are several, the compiler uses whichever its directory listing returns first.

**Idris 2: Show Setup Information** lists the packages in the workspace and the one the active file belongs to.

Besides `.idr` and bird-style `.lidr` files, a Markdown, LaTeX, Org, Djot or Typst file counts as Idris when its name has a double extension such as `Main.idr.md` or `Notes.lidr.tex`.
