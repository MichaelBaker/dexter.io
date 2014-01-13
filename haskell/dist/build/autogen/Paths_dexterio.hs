module Paths_dexterio (
    version,
    getBinDir, getLibDir, getDataDir, getLibexecDir,
    getDataFileName
  ) where

import qualified Control.Exception as Exception
import Data.Version (Version(..))
import System.Environment (getEnv)
import Prelude

catchIO :: IO a -> (Exception.IOException -> IO a) -> IO a
catchIO = Exception.catch


version :: Version
version = Version {versionBranch = [0,1,0,0], versionTags = []}
bindir, libdir, datadir, libexecdir :: FilePath

bindir     = "/home/vagrant/.cabal/bin"
libdir     = "/home/vagrant/.cabal/lib/i386-linux-ghcjs-0.1.0_ghc-7.7.20130908/dexterio-0.1.0.0"
datadir    = "/home/vagrant/.cabal/share/i386-linux-ghcjs-0.1.0_ghc-7.7.20130908/dexterio-0.1.0.0"
libexecdir = "/home/vagrant/.cabal/libexec"

getBinDir, getLibDir, getDataDir, getLibexecDir :: IO FilePath
getBinDir = catchIO (getEnv "dexterio_bindir") (\_ -> return bindir)
getLibDir = catchIO (getEnv "dexterio_libdir") (\_ -> return libdir)
getDataDir = catchIO (getEnv "dexterio_datadir") (\_ -> return datadir)
getLibexecDir = catchIO (getEnv "dexterio_libexecdir") (\_ -> return libexecdir)

getDataFileName :: FilePath -> IO FilePath
getDataFileName name = do
  dir <- getDataDir
  return (dir ++ "/" ++ name)
