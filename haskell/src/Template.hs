{-# LANGUAGE OverloadedStrings #-}

module Template where

import Prelude hiding (div)
import Data.String                   (fromString)
import Text.Blaze.Html5              (div, input, (!), toHtml)
import Text.Blaze.Html5.Attributes   (class_, value)
import Text.Blaze.Html.Renderer.Text (renderHtml)
import Text.Blaze                    (customAttribute)
import JavaScript.JQuery             (select, find, getVal, click, keyup, change, setHtml, append)
import Control.Monad                 (forM_)
import Data.Text.Lazy                (toStrict)
import Data.Text                     (pack, unpack)
import Data.Default                  (def)
import Safe                          (readMay)
import Control.Concurrent.Chan       (writeChan)

import Counter     (Counter (..), total)
import CounterApp  (CounterApp (..), pointsRemaining)
import AppEvent    (AppEvent (..))

render counterApp parent eventChannel = do
  if (gameOver counterApp)
    then setHtml (toStrict $ renderHtml $ endGameTemplate   counterApp) parent
    else setHtml (toStrict $ renderHtml $ startGameTemplate counterApp) parent
  setupAddCounterButton  eventChannel
  setupEndGameButton     eventChannel
  setupResumeGameButton  eventChannel
  setupAddMaxPointButton eventChannel
  mapM_ (setupAddPointButton eventChannel parent) $ counters counterApp
  mapM_ (setupCardScore      eventChannel) $ counters counterApp

renderDiff oldCounterApp newCounterApp parent eventChannel = do
  if gameOver oldCounterApp /= gameOver newCounterApp
    then render newCounterApp parent eventChannel
    else unless (oldCounterApp == newCounterApp) (updateApp oldCounterApp newCounterApp parent eventChannel)

updateApp old new parent eventChannel = do
  unless (pointsRemaining old == pointsRemaining new) $ updatePointsRemaining (pointsRemaining new) parent
  unless (counters old == counters new)               $ updateCounters (counters old) (counters new) parent eventChannel

updatePointsRemaining points parent = do
  pointsElement <- find ".points-remaining" parent
  setHtml (pack $ show points) pointsElement
  return ()

updateCounters old new parent eventChannel = do
  forM_ old $ \old -> do
    forM_ new $ \new -> do
      if counterId old == counterId new && old /= new then (updateCounter old new parent) else return ()
  forM_ (newCounters old new) $ addCounter parent eventChannel

newCounters old new = filter (\n -> not $ counterId n `elem` map counterId old) new

updateCounter old new parent = do
  unless (score old == score new) $ updateScore (score new) (counterId new) parent
  unless (total old == total new) $ updateTotal (total new) (counterId new) parent

updateScore score counterId parent = do
  scoreElement <- find (pack $ ".counter[counter-id=" ++ show counterId ++ "] > .score") parent
  setHtml (pack $ show score) scoreElement
  return ()

updateTotal score counterId parent = do
  scoreElement <- find (pack $ ".counter[counter-id=" ++ show counterId ++ "] > .total-score") parent
  setHtml (pack $ show score) scoreElement
  return ()

addCounter parent eventChannel counter = do
  countersElement <- find ".counters" parent
  append (toStrict $ renderHtml $ counterTemplate counter) countersElement
  setupAddPointButton eventChannel countersElement counter

attr = customAttribute
unless a f = if a then return () else f

counterTemplate counter = do
  div ! class_ "counter" ! attr "counter-id" (fromString $ show $ counterId counter) $ do
    input ! class_ "player-name" ! value (fromString $ playerName counter)
    div ! class_ "minus" $ "-" 
    div ! class_ "score" $ toHtml (score counter)
    div ! class_ "plus" $ "+"

startGameTemplate counterApp = do
  div ! class_ "counter-app" $ do
    div ! class_ "add-counter-button" $ do
      "Add Counter"
  div ! class_ "subtract-point-button" $ do
    "-"
  div ! class_ "points-remaining" $ toHtml (pointsRemaining counterApp)
  div ! class_ "add-point-button" $ do
    "+"
  div ! class_ "counters" $ do
    forM_ (counters counterApp) counterTemplate
  div ! class_ "end-game-button" $ do
    "End Game"

endGameTemplate counterApp = do
  forM_ (counters counterApp) $ \counter -> do
    div ! class_ "counter" ! attr "counter-id" (fromString $ show $ counterId counter) $ do
      div $ fromString $ playerName counter
      div ! class_ "total-score" $ toHtml $ score counter + cardScore counter
      div $ "Card Score"
      input ! class_ "card-score" ! value (fromString $ show $ cardScore counter)
  div ! class_ "resume-game-button" $ do
    "Resume Game"

setupAddCounterButton eventChannel = do
  addCounterButton <- select ".add-counter-button"
  let action = writeChan eventChannel $ AddCounter "Enter Name"
  click (const action) def addCounterButton

setupEndGameButton eventChannel = do
  endGameButton <- select ".end-game-button"
  let action = writeChan eventChannel $ EndGame
  click (const action) def endGameButton

setupAddMaxPointButton eventChannel = do
  addPointButton      <- select ".add-point-button"
  subtractPointButton <- select ".subtract-point-button"
  let add   = writeChan eventChannel AddPoint
      minus = writeChan eventChannel SubtractPoint
  click (const add)   def addPointButton
  click (const minus) def subtractPointButton

setupResumeGameButton eventChannel = do
  resumeGameButton <- select ".resume-game-button"
  let action = writeChan eventChannel $ ResumeGame
  click (const action) def resumeGameButton

setupAddPointButton eventChannel parent counter = do
  counterElement <- find (pack $ ".counter[counter-id=" ++ show (counterId counter) ++ "]") parent
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
  let handle = getVal nameElement >>= (\name -> writeChan channel $ NameChange counterId $ unpack name)
  keyup (const handle) def nameElement

setupCardScore eventChannel counter = do
  counterElement   <- select $ pack $ ".counter[counter-id=" ++ show (counterId counter) ++ "]"
  cardScoreElement <- find ".card-score" counterElement
  change (const $ handleCardScore cardScoreElement eventChannel counter) def cardScoreElement

handleCardScore cardScoreElement eventChannel counter = do
  scoreText <- getVal cardScoreElement
  case readMay $ unpack scoreText of
    Nothing       -> return ()
    Just newScore -> writeChan eventChannel $ CardScore (counterId counter) newScore
