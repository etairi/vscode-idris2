# Open an Idris 2 project

Open the folder that contains your package's `.ipkg` file, or any folder of `.idr` files.

- A file belongs to the package of the nearest `.ipkg` found by walking up from the file's folder, the same search the compiler does, even when that `.ipkg` lies above the folder you opened. The compiler works from the `.ipkg`'s directory, where its `sourcedir`, `depends` and `builddir` apply.
- A file with no `.ipkg` above it is a loose file.
- Keep one `.ipkg` per directory: when there are several, the compiler uses whichever its directory listing returns first.

An Idris file is checked when you open it and each time you save it (`idris2.checking.trigger`; **Idris 2: Check File** checks it on request): the compiler's errors and warnings appear in the editor and the Problems panel. It checks the file as saved, so the status says `stale` while there are unsaved changes. The compiler runs in the `.ipkg`'s directory, or a loose file's. When that directory lies outside the folders you opened, the extension asks before starting the compiler there, since starting it in a folder can run code placed in it; **Idris 2: Manage Allowed Folders…** lists and revokes the folders you allowed for good.

**Idris 2: Show Setup Information** lists the packages in the workspace and the one the active file belongs to.

Besides `.idr` and bird-style `.lidr` files, a Markdown, LaTeX, Org, Djot or Typst file counts as Idris when its name has a double extension such as `Main.idr.md` or `Notes.lidr.tex`.
