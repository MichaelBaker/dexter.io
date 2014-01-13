{-# LANGUAGE OverloadedStrings #-}

import Prelude hiding (div)
import JavaScript.JQuery
import Control.Concurrent.Chan
import Data.Default
import Control.Monad
import qualified Data.Text as T
import qualified Data.Text.Lazy as TL
import Text.Blaze.Html5 hiding (select, map)
import Text.Blaze.Html.Renderer.Text
import Text.Blaze.Html5.Attributes hiding (loop, max)
import Text.Blaze
import Data.String

data AppEvent = Plus Int
              | Minus Int
              | AddCounter String
              deriving (Show, Eq)


data CounterApp = CounterApp { maxPoints :: Int
                             , counters  :: [Counter]
                             } deriving (Show, Eq)

data Counter = Counter { score      :: Int
                       , playerName :: String
                       , counterId  :: Int
                       } deriving (Show, Eq)

counterHtml playerName = div $ toHtml playerName

main = do
  eventChannel <- newChan
  loop (CounterApp 0 []) eventChannel

loop counterApp eventChannel = do
  body    <- select "body"
  setHtml (TL.toStrict $ renderHtml $ render counterApp) body
  setHandlers eventChannel counterApp
  event   <- readChan eventChannel
  loop (processEvent counterApp event) eventChannel

render counterApp = do
  div ! class_ "counter-app" $ do
    div ! class_ "add-counter-button" $ do
      "Add Counter"
  div $ toHtml (pointsRemaining counterApp)
  forM_ (counters counterApp) $ \counter -> do
    div ! class_ "counter" ! attr "counter-id" (fromString $ show $ counterId counter) $ do
      toHtml (playerName counter)
      div ! class_ "minus" $ "-" 
      div $ toHtml (score counter)
      div ! class_ "plus" $ "+"

attr = customAttribute

setHandlers eventChannel app = do
  setupAddCounterButton eventChannel
  mapM_ (setupAddPointButton eventChannel) $ counters app

setupAddCounterButton eventChannel = do
  addCounterButton <- select ".add-counter-button"
  let action = writeChan eventChannel $ AddCounter "Hello"
  click (const action) def addCounterButton

setupAddPointButton eventChannel counter = do
  counterElement <- select $ T.pack $ ".counter[counter-id=" ++ show (counterId counter) ++ "]"
  setupPlayerClick eventChannel (counterId counter) counterElement

processEvent app (AddCounter playerName) = newCounterApp
  where newCounterApp = app { counters = newCounters, maxPoints = newPoints }
        newPoints     = maxPoints app + 30
        newCounters   = counters app ++ [Counter 0 playerName $ length $ counters app]
processEvent app (Plus targetId)  = app { counters = newCounters }
  where newCounters    = map update $ counters app
        update counter = if counterId counter == targetId then counter { score = score counter + 1 } else counter
processEvent app (Minus targetId) = app { counters = newCounters }
  where newCounters    = map update $ counters app
        update counter = if counterId counter == targetId then counter { score = max 0 $ score counter - 1 } else counter

pointsRemaining app = max 0 $ maxPoints app - (sum $ map score $ counters app)

setupPlayerClick ch counterId el = do
  plusEl  <- find ".plus" el
  minusEl <- find ".minus" el

  forM_ [(plusEl, Plus), (minusEl, Minus)] $ \(clickedEl, ctor) -> do
    let action = writeChan ch (ctor counterId)
    click (const action) def clickedEl
