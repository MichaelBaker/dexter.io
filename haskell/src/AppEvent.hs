module AppEvent where

import CounterApp (CounterApp (..))
import Counter    (Counter (..), newCounter)

data AppEvent = Plus Int
              | Minus Int
              | AddCounter String
              | NameChange Int String
              | EndGame
              | ResumeGame
              | CardScore Int Int
              | AddPoint
              | SubtractPoint
              deriving (Show, Eq)

processEvent app (AddCounter playerName) = newCounterApp
  where newCounterApp = app { counters = newCounters, maxPoints = newPoints }
        newPoints     = maxPoints app + 30
        newCounters   = counters app ++ [newCounter playerName (length $ counters app)]
processEvent app (Plus targetId)  = app { counters = newCounters }
  where newCounters    = map update $ counters app
        update counter = if counterId counter == targetId then counter { score = score counter + 1 } else counter
processEvent app (Minus targetId) = app { counters = newCounters }
  where newCounters    = map update $ counters app
        update counter = if counterId counter == targetId then counter { score = max 0 $ score counter - 1 } else counter
processEvent app (NameChange targetId newName) = app { counters = newCounters }
  where newCounters    = map update $ counters app
        update counter = if counterId counter == targetId then counter { playerName = newName } else counter
processEvent app (CardScore targetId score) = app { counters = newCounters }
  where newCounters    = map update $ counters app
        update counter = if counterId counter == targetId then counter { cardScore = score } else counter
processEvent app EndGame       = app { gameOver = True }
processEvent app ResumeGame    = app { gameOver = False }
processEvent app AddPoint      = app { maxPoints = maxPoints app + 1 }
processEvent app SubtractPoint = app { maxPoints = max 0 $ maxPoints app - 1 }
