{-# LANGUAGE OverloadedStrings #-}

import JavaScript.JQuery             (select, find, getVal, click, change, setHtml)
import Control.Concurrent.Chan       (newChan, writeChan, readChan)
import Data.Default                  (def)
import Text.Blaze.Html.Renderer.Text (renderHtml)
import Control.Monad                 (forM_)
import Safe                          (readMay)
import Data.Text                     (pack, unpack)
import Data.Text.Lazy                (toStrict)

import CounterApp (CounterApp (..), newCounterApp, pointsRemaining)
import Counter    (Counter (..))
import AppEvent   (AppEvent (..), processEvent)
import Template   (render)

main = do
  eventChannel <- newChan
  loop newCounterApp eventChannel

loop counterApp eventChannel = do
  body    <- select "body"
  setHtml (toStrict $ renderHtml $ render counterApp) body
  setHandlers eventChannel counterApp
  event   <- readChan eventChannel
  loop (processEvent counterApp event) eventChannel

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
  counterElement <- select $ pack $ ".counter[counter-id=" ++ show (counterId counter) ++ "]"
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
  change (const handle) def nameElement

setupCardScore eventChannel counter = do
  counterElement   <- select $ pack $ ".counter[counter-id=" ++ show (counterId counter) ++ "]"
  cardScoreElement <- find ".card-score" counterElement
  change (const $ handleCardScore cardScoreElement eventChannel counter) def cardScoreElement

handleCardScore cardScoreElement eventChannel counter = do
  scoreText <- getVal cardScoreElement
  case readMay $ unpack scoreText of
    Nothing       -> return ()
    Just newScore -> writeChan eventChannel $ CardScore (counterId counter) newScore
