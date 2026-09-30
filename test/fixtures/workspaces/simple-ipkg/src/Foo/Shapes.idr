module Foo.Shapes

||| A plane figure.
public export
data Shape : Type where
  ||| A circle, by its radius.
  Circle : Double -> Shape
  Rectangle : Double -> Double -> Shape

||| The area of a shape.
export
area : Shape -> Double
area (Circle r) = pi * r * r
area (Rectangle w h) = w * h

||| Things whose boundary has a length.
public export
interface Measured a where
  ||| The length of the boundary.
  perimeter : a -> Double

export
Measured Shape where
  perimeter (Circle r) = 2 * pi * r
  perimeter (Rectangle w h) = 2 * (w + h)

export
scale : Double -> Shape -> Shape
scale k (Circle r) = let r' = k * r in Circle r'
scale k (Rectangle w h) = Rectangle (k * w) (k * h)

export
twice : (Shape -> Shape) -> Shape -> Shape
twice f = \s => f (f s)

export infixl 6 |+|

||| The areas of two shapes, added.
export
(|+|) : Shape -> Shape -> Double
a |+| b = area a + area b
