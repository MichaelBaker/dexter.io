{-# LANGUAGE OverloadedStrings #-}

import Control.Concurrent.Chan (newChan, readChan)
import JavaScript.JQuery       (select)

import CounterApp (newCounterApp)
import AppEvent   (processEvent)
import Template   (render, renderDiff)

main = do
  eventChannel <- newChan
  body <- select "body"
  render newCounterApp body eventChannel
  loop newCounterApp eventChannel body

loop oldCounterApp eventChannel body = do
  event <- readChan eventChannel
  let newCounterApp = processEvent oldCounterApp event
  renderDiff oldCounterApp newCounterApp body eventChannel
  loop newCounterApp eventChannel body
