#!/bin/bash
set -e
set -x

dupecmp() {
  find $1 -type f -exec sh -c 'md5sum --tag "{}" ;' \;
}

# clean
rm -rf dupeout1 dupeout2 || true
pismo remove dupetest1 || true
pismo remove dupetest2 || true

# set up remotes
pismo remote-remove local || true
pismo remote-add local http://localhost:48880

# set up dupeout1 for expected snapshot
cp -r -p dupedata1 dupeout1
rm dupeout1/identical_copy.txt  # remove each file that is dupelicated within dupeout1

# create expected output files
cp -r -p dupeout1 dupeout2
dupecmp dupeout1 > dupeout1-expected.txt
dupecmp dupeout2 > dupeout2-expected.txt
rm -rf dupeout2

# set up dupeout1
rm -rf dupeout1
cp -r -p dupedata1 dupeout1

# set up dupeout2
find dupedata2 -type f | xargs touch
cp -r -p dupedata2 dupeout2

# scan with pismo
pismo add dupetest1 dupeout1
pismo add dupetest2 dupeout2
pismo update dupetest1
pismo update dupetest2

# update remote
pismo fetch local

# dedupe with pismo
pismo merge-gen dupetest1 local/dupetest2 --mode=deduplicate merge.json
pismo merge-apply merge.json

# create actual output
dupecmp dupeout1 > dupeout1-actual.txt
dupecmp dupeout2 > dupeout2-actual.txt

# compare
diff dupeout1-expected.txt dupeout1-actual.txt
diff dupeout2-expected.txt dupeout2-actual.txt

# clean up
pismo remove dupetest1
pismo remove dupetest2
pismo remote-remove local

echo "test passed successfully"
