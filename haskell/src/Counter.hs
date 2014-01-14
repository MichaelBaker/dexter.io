module Counter where

data Counter = Counter { score      :: Int
                       , cardScore  :: Int
                       , playerName :: String
                       , counterId  :: Int
                       } deriving (Show, Eq)

newCounter name counterId = Counter 0 0 name counterId

total c = score c + cardScore c
