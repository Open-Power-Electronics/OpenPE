/* SPDX-License-Identifier: GPL-2.0-or-later
 * Native batch entry for the official Gmsh Linux library. No Python runtime.
 */
#include "gmshc.h"

int main(int argc, char **argv) {
    int error = 0;
    /* Never read user or system option files in the engineering host. */
    gmshInitialize(argc, argv, 0, 1, &error);
    if (error) return 1;
    gmshFinalize(&error);
    return error ? 1 : 0;
}
