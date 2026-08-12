#!/bin/sh
set -e
DATA=/data/arizona

if [ ! -f "${DATA}.osrm.mldgr" ]; then
  echo "OSRM: processing Arizona OSM data..."
  osrm-extract -p /opt/car.lua "${DATA}.osm.pbf"
  echo "OSRM: partitioning..."
  osrm-partition "${DATA}.osrm"
  echo "OSRM: customizing..."
  osrm-customize "${DATA}.osrm"
  echo "OSRM: data ready."
fi

exec osrm-routed --algorithm mld --max-table-size 10000 "${DATA}.osrm"
