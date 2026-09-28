module Logging

-- The pragma makes the compiler print LOG lines on its stdout while it elaborates f; over
-- --ide-mode that is the protocol stream (transcript load-logging).
%logging "declare.def" 3

f : Nat
f = 1
