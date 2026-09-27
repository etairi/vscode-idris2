# Third-party material in the grammar fixtures

Most fixtures in this directory were written for this repository. The files below contain
material from other projects, reproduced under the licences that follow. Each file's header
names its source file, commit and the changes made.

| Fixture | Source | Licence |
|---|---|---|
| `IctPosition.idr` | idris-compiler-tools `lng-compiler/src/Parse/Data/Position.idr` | MIT (Jan Serwatka) |
| `IctAttached.idr` | idris-compiler-tools `lng-compiler/src/Data/Attached.idr` | MIT (Jan Serwatka) |
| `IctEdge.idr` | idris-compiler-tools `control-flow/src/ControlFlow/Edge.idr` | MIT (Jan Serwatka) |
| `BaseLibFin.idr` | Idris 2 `libs/base/Data/Fin.idr` | BSD 3-Clause (Edwin Brady) |
| `InitTemplate.ipkg` | the field comments of Idris 2's package pretty-printer (`src/Idris/Package/Types.idr`), as stated in the file's header | BSD 3-Clause (Edwin Brady) |

- idris-compiler-tools: https://github.com/JankaGramofonomanka/idris-compiler-tools, commit
  `e323d4707231ea0fb57b6b4015a35a6440cdc42a`; `control-flow/LICENSE.md` and
  `lng-compiler/LICENSE.md` are identical.
- Idris 2: https://github.com/idris-lang/Idris2, tag `v0.8.0` (commit
  `15a3e4e70843f7a34100f6470c04b791330788df`), `LICENSE`.

The real-world corpora used by `test/grammar/corpus.test.ts` (`test/corpus/corpus.json`) are
fetched at test time into `.corpus/` and are not part of this repository.

## MIT License (idris-compiler-tools)

```
MIT License

Copyright (c) 2023 Jan Serwatka

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## BSD 3-Clause License (Idris 2)

```
Copyright (c) 2020 Edwin Brady
    School of Computer Science, University of St Andrews
All rights reserved.

This code is derived from software written by Edwin Brady
(ecb10@st-andrews.ac.uk).

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. None of the names of the copyright holders may be used to endorse
   or promote products derived from this software without specific
   prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS ``AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT HOLDERS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN
IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

*** End of disclaimer. ***
```
