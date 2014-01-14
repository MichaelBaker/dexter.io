{-# LANGUAGE OverloadedStrings #-}

import Prelude hiding (div, span)
import JavaScript.JQuery
import Control.Concurrent.Chan
import Data.Default
import Control.Monad
import qualified Data.Text as T
import qualified Data.Text.Lazy as TL
import Text.Blaze.Html5 hiding (select, map)
import Text.Blaze.Html.Renderer.Text
import Text.Blaze.Html5.Attributes hiding (loop, max, span)
import Text.Blaze
import Data.String
import Safe

data AppEvent = Plus Int
              | Minus Int
              | AddCounter String
              | NameChange Int String
              | EndGame
              | ResumeGame
              | CardScore Int Int
              | AddPoint
              deriving (Show, Eq)


data CounterApp = CounterApp { maxPoints :: Int
                             , counters  :: [Counter]
                             , gameOver  :: Bool
                             } deriving (Show, Eq)

data Counter = Counter { score      :: Int
                       , cardScore  :: Int
                       , playerName :: String
                       , counterId  :: Int
                       } deriving (Show, Eq)

main = do
  eventChannel <- newChan
  loop (CounterApp 0 [] False) eventChannel

loop counterApp eventChannel = do
  body    <- select "body"
  setHtml (TL.toStrict $ renderHtml $ render counterApp) body
  setHandlers eventChannel counterApp
  event   <- readChan eventChannel
  loop (processEvent counterApp event) eventChannel

render counterApp = if (gameOver counterApp)
                      then endGameTemplate   counterApp
                      else startGameTemplate counterApp

startGameTemplate counterApp = do
  div ! class_ "counter-app" $ do
    div ! class_ "add-counter-button" $ do
      "Add Counter"
    div ! class_ "add-point-button" $ do
      "Add Point"
  div $ toHtml (pointsRemaining counterApp)
  forM_ (counters counterApp) $ \counter -> do
    div ! class_ "counter" ! attr "counter-id" (fromString $ show $ counterId counter) $ do
      input ! class_ "player-name" ! value (fromString $ playerName counter)
      div ! class_ "minus" $ "-" 
      div $ toHtml (score counter)
      div ! class_ "plus" $ "+"
  div ! class_ "end-game-button" $ do
    "End Game"

endGameTemplate counterApp = do
  forM_ (counters counterApp) $ \counter -> do
    div ! class_ "counter" ! attr "counter-id" (fromString $ show $ counterId counter) $ do
      div $ fromString $ playerName counter
      div $ toHtml $ score counter + cardScore counter
      div $ "Card Score"
      input ! class_ "card-score" ! value (fromString $ show $ cardScore counter)
  div ! class_ "resume-game-button" $ do
    "Resume Game"

attr = customAttribute

processEvent app (AddCounter playerName) = newCounterApp
  where newCounterApp = app { counters = newCounters, maxPoints = newPoints }
        newPoints     = maxPoints app + 30
        newCounters   = counters app ++ [Counter 0 0 playerName $ length $ counters app]
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
processEvent app EndGame    = app { gameOver = True }
processEvent app ResumeGame = app { gameOver = False }
processEvent app AddPoint   = app { maxPoints = maxPoints app + 1 }

pointsRemaining app = max 0 $ maxPoints app - (sum $ map score $ counters app)

setHandlers eventChannel app = do
  setupAddCounterButton  eventChannel
  setupEndGameButton     eventChannel
  setupResumeGameButton  eventChannel
  setupAddMaxPointButton eventChannel
  mapM_ (setupAddPointButton eventChannel) $ counters app
  mapM_ (setupCardScore eventChannel)      $ counters app

setupAddCounterButton eventChannel = do
  addCounterButton <- select ".add-counter-button"
  let action = writeChan eventChannel $ AddCounter "Enter Name"
  click (const action) def addCounterButton

setupEndGameButton eventChannel = do
  endGameButton <- select ".end-game-button"
  let action = writeChan eventChannel $ EndGame
  click (const action) def endGameButton

setupAddMaxPointButton eventChannel = do
  addPointButton <- select ".add-point-button"
  let action = writeChan eventChannel AddPoint
  click (const action) def addPointButton

setupResumeGameButton eventChannel = do
  resumeGameButton <- select ".resume-game-button"
  let action = writeChan eventChannel $ ResumeGame
  click (const action) def resumeGameButton

setupAddPointButton eventChannel counter = do
  counterElement <- select $ T.pack $ ".counter[counter-id=" ++ show (counterId counter) ++ "]"
  setupPlayerClick eventChannel (counterId counter) counterElement
  setupNameChange  eventChannel (counterId counter) counterElement

setupPlayerClick ch counterId el = do
  plusEl  <- find ".plus" el
  minusEl <- find ".minus" el

  forM_ [(plusEl, Plus), (minusEl, Minus)] $ \(clickedEl, ctor) -> do
    let action = writeChan ch (ctor counterId)
    click (const action) def clickedEl

setupNameChange channel counterId element = do
  nameElement <- find ".player-name" element
  let handle = getVal nameElement >>= (\name -> writeChan channel $ NameChange counterId $ T.unpack name)
  change (const handle) def nameElement

setupCardScore eventChannel counter = do
  counterElement   <- select $ T.pack $ ".counter[counter-id=" ++ show (counterId counter) ++ "]"
  cardScoreElement <- find ".card-score" counterElement
  change (const $ handleCardScore cardScoreElement eventChannel counter) def cardScoreElement

handleCardScore cardScoreElement eventChannel counter = do
  scoreText <- getVal cardScoreElement
  case readMay $ T.unpack scoreText of
    Nothing       -> return ()
    Just newScore -> writeChan eventChannel $ CardScore (counterId counter) newScore
