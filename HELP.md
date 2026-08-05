# Pipe Fitter

Pipe Fitter is a tool that helps create transition connections from one tube-shaped object (like a PVC pipe or a
hose) to another. You can change the inner and outer diameter of each section, adjust the style of each end, and add
bends between the sections.

The pipe is built as a chain of straight **sections** joined by **bends**: Section 1, Bend 1, Section 2, Bend 2,
Section 3, and so on. The first and last section headers have a **+ Section** button that adds a new end section (the
first prepends, the last appends, each copying the section it was created from), and a **✕** button to remove an end
section. You can click on any section header to collapse it and make more room.

## Sections

Each section controls one straight run of the pipe. Start by specifying the inner and outer diameters. Then specify the
length. Use **Mimic Previous Section** / **Mimic Next Section** buttons to match a neighbor.

Only the **first and last** sections have an **End Treatment** (the two open ends of the pipe):

- **Plain** is just a flat end.
- **Chamfer** lets you apply a taper to either the inside of the pipe, the outside of the pipe, or both. You can
  specify how far along the pipe the chamfer should travel (**X, along axis**), as well as how much of the thickness
  of the pipe the chamfer should consume (**Y, radial**). A chamfer with 0 for all of its values is the same as a
  Plain end.
- **Flange** adds a flat ring to the end of the pipe. You can specify how wide the ring is, how thick it is, and also
  add holes symmetrically around the center of the ring.
- **Hose Barb** adds a sharp saw-tooth shape to the end. You can control the height, spacing, and number of teeth to
  add.
- **Teeth** are like small sections  of hose barb, spaced out evenly around the opening. They can be rounded over
  smooth. They are useful for soft hoses lined with coiled wire, providing something for the hose to grab or screw
  onto without damaging it. Such hoses should still be clamped.
- **Fit** makes a telescoping slip joint so two pipes slide together. Choose **Inside** for a spigot that plugs into
  the mating pipe (its outer Ø is set to this section's inner Ø minus the tolerance), or **Outside** for a socket the
  mate plugs into (its bore is set to this section's outer Ø plus the tolerance). The stub is included in the
  section's length, so the section's length remains unchnaged. The two pipes bottom out against a flat shoulder, and a
  lead-in chamfer (on the spigot's outer tip, or the socket's bore mouth) eases them together. Increase the
  **tolerance** for a looser, easier slide; decrease it for a snugger fit.

## Bends

Each bend joins two neighboring sections. Set its angle anywhere from −90° to 90° — the sign chooses which way it
turns, so two bends with alternating signs make an S-shape. An angle of 0° is a straight transition. The **Length**
option measures the bend's length when it is straight, but changes to measure the length along the outside of the inner
bend once there is any angle. All bends share one plane.

By default a bend blends the inner diameter and wall thickness **smoothly** from one neighboring section to the
other. Turn off **Continuous Ø** or **Continuous thickness** to instead set a fixed value at the middle of the
transition: make the diameter larger than both neighbors for a bulge or smaller for a pinch, and likewise thicken or
thin the wall. Each of these fixed controls includes buttons to quickly match the left neighbor, the right
neighbor, or the average of the two.

## Download

You can download your pipe as either an STL or 3MF using the menus at the top. They can be oriented to stand on the
first or last end, to make 3D printing easier, or downloaded as-is.

## Questions/Comments/Concerns?

Reach out to Dave - mankyd@gmail.com
