module CounterApp where

import Counter (Counter, score)

data CounterApp = CounterApp { maxPoints :: Int
                             , counters  :: [Counter]
                             , gameOver  :: Bool
                             } deriving (Show, Eq)

newCounterApp = CounterApp 0 [] False
pointsRemaining app = max 0 $ maxPoints app - (sum $ map score $ counters app)
