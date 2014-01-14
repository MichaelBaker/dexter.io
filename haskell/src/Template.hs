{-# LANGUAGE OverloadedStrings #-}

module Template where

import Prelude hiding (div)
import Data.String                   (fromString)
import Text.Blaze.Html5              (div, input, (!), toHtml)
import Text.Blaze.Html5.Attributes   (class_, value)
import Text.Blaze                    (customAttribute)
import Control.Monad                 (forM_)
import Counter                       (Counter (..))
import CounterApp                    (CounterApp (..), pointsRemaining)

render counterApp = if (gameOver counterApp)
                      then endGameTemplate   counterApp
                      else startGameTemplate counterApp

attr = customAttribute

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
